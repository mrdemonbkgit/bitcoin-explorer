import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Level } from 'level';
import { LRUCache } from 'lru-cache';
import { config } from '../config.js';
import { getLogger } from './logger.js';
import { metrics } from './metrics.js';
import { PrevoutWorkerPool, isWorkerThreadsAvailable } from './prevoutWorkerPool.js';
import { rpcCall } from '../rpc.js';
import { NotFoundError } from '../errors.js';
import { CacheEvents, subscribe } from './cacheEvents.js';

const SATOSHIS_PER_BTC = 100_000_000;
const HEIGHT_PAD = 12;
const INDEX_PAD = 6;
const PREFIXES = {
  META: 'meta!',
  SUMMARY: 'addr!',
  UTXO: 'utxo!',
  TX: 'tx!'
};

const DIRECTION_IN = 'in';
const DIRECTION_OUT = 'out';

const HR_TO_MS = 1e6;
const MAX_RECOMMENDED_CONCURRENCY = 8;

function now() {
  return process.hrtime.bigint();
}

function durationMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / HR_TO_MS;
}

async function runWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return;
  }
  const limit = Math.max(1, concurrency || 1);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      await tasks[current]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
}

function createEmptySyncStats() {
  return {
    blocksProcessed: 0,
    transactionsProcessed: 0,
    prevoutCacheHits: 0,
    prevoutRpcCalls: 0
  };
}

/**
 * @typedef {Object} AddressSummary
 * @property {string} address
 * @property {number|null} firstSeenHeight
 * @property {number|null} lastSeenHeight
 * @property {number} totalReceivedSat
 * @property {number} totalSentSat
 * @property {number} balanceSat
 * @property {number} txCount
 * @property {number} utxoCount
 * @property {number} utxoValueSat
 */

/**
 * @typedef {Object} AddressUtxoRecord
 * @property {string} address
 * @property {string} txid
 * @property {number} vout
 * @property {number} valueSat
 * @property {number|null} height
 */

/**
 * @typedef {Object} AddressTxRecord
 * @property {string} address
 * @property {string} txid
 * @property {number|null} height
 * @property {typeof DIRECTION_IN | typeof DIRECTION_OUT} direction
 * @property {number|null} valueSat
 * @property {number} ioIndex
 * @property {number|null} timestamp
 */

/**
 * @typedef {{ type: 'put'; key: string; value: unknown }} BatchPutOperation
 * @typedef {{ type: 'del'; key: string }} BatchDelOperation
 * @typedef {BatchPutOperation | BatchDelOperation} BatchOperation
 */

let singletonIndexer = null;

async function fetchBlockWithRetry(hash, logger, { maxAttempts = 15, baseDelayMs = 200 } = {}) {
  let attempt = 0;
  let lastError = null;
  while (attempt < maxAttempts) {
    try {
      return await rpcCall('getblock', [hash, 2]);
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
      lastError = error;
      attempt += 1;
      if (attempt >= maxAttempts) {
        break;
      }
      const backoffMs = baseDelayMs * attempt;
      logger.debug({
        context: {
          event: 'addressIndexer.block.retry',
          hash,
          attempt,
          delayMs: backoffMs
        }
      }, 'Retrying getblock after not found');
      await delay(backoffMs);
    }
  }

  throw lastError ?? new NotFoundError('Block not found');
}

function sats(value) {
  if (typeof value !== 'number') {
    return 0;
  }
  return Math.round(value * SATOSHIS_PER_BTC);
}

function ensureDirectory(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function metaKey(key) {
  return `${PREFIXES.META}${key}`;
}

function summaryKey(address) {
  return `${PREFIXES.SUMMARY}${address}`;
}

function utxoKey(address, txid, vout) {
  return `${PREFIXES.UTXO}${address}!${txid}!${String(vout)}`;
}

function txKey(address, height, direction, ioIndex, txid) {
  return `${PREFIXES.TX}${address}!${formatHeight(height)}!${direction}!${padIndex(ioIndex)}!${txid}`;
}

function prefixRange(prefix) {
  return {
    gte: prefix,
    lt: `${prefix}\uFFFF`
  };
}

function formatHeight(height) {
  if (typeof height !== 'number' || height < 0) {
    return 'mempool';
  }
  return height.toString().padStart(HEIGHT_PAD, '0');
}

function padIndex(index) {
  return index.toString().padStart(INDEX_PAD, '0');
}

function createSummary(address, height) {
  const numericHeight = typeof height === 'number' ? height : null;
  /** @type {AddressSummary} */
  const summary = {
    address,
    firstSeenHeight: numericHeight,
    lastSeenHeight: numericHeight,
    totalReceivedSat: 0,
    totalSentSat: 0,
    balanceSat: 0,
    txCount: 0,
    utxoCount: 0,
    utxoValueSat: 0
  };
  return summary;
}

/**
 * @param {AddressSummary} summary
 */
function sanitizeSummary(summary) {
  const clone = { ...summary };
  clone.balanceSat = Math.max(0, clone.balanceSat);
  clone.utxoCount = Math.max(0, clone.utxoCount);
  clone.utxoValueSat = Math.max(0, clone.utxoValueSat);
  return clone;
}

function isNotFound(error) {
  return error?.notFound || error?.code === 'LEVEL_NOT_FOUND';
}

export class AddressIndexer {
  constructor(options = {}) {
    const { dbPath, gapLimit, logger } = options;
    this.dbPath = dbPath ?? path.resolve('./data/address-index');
    this.gapLimit = gapLimit ?? 20;
    this.logger = logger ?? getLogger().child({ module: 'address-indexer' });
    /** @type {import('level').Level<string, unknown> | null} */
    this.db = null;
    this.subscriptions = [];
    this.prevoutCacheMax = config.address.prevoutCacheMax;
    this.prevoutCacheTtl = config.address.prevoutCacheTtl;
    this.prevoutCache = new LRUCache({
      max: this.prevoutCacheMax,
      ttl: this.prevoutCacheTtl,
      ttlAutopurge: true
    });
    this.prevoutConcurrency = Math.max(1, config.address.indexerConcurrency);
    this.parallelPrevoutEnabled = Boolean(config.address.parallelPrevoutEnabled);
    this.levelCacheBytes = config.address.levelCacheBytes;
    this.levelWriteBufferBytes = config.address.levelWriteBufferBytes;
    this.batchBlockCount = Math.max(1, config.address.batchBlockCount);
    this.prevoutWorkerPool = null;
    this.prevoutWorkerPoolReady = null;
    this.prevoutWorkerPoolDisabled = false;
    this.stopping = false;
    this.signalHandlers = [];
    this.syncInProgress = false;
    this.syncChain = Promise.resolve();
    this.syncStats = createEmptySyncStats();
  }

  async open() {
    ensureDirectory(this.dbPath);
    const levelOptions = { valueEncoding: 'json' };
    if (this.levelCacheBytes > 0) {
      levelOptions.cacheSize = this.levelCacheBytes;
    }
    if (this.levelWriteBufferBytes > 0) {
      levelOptions.writeBufferSize = this.levelWriteBufferBytes;
    }
    /** @type {import('level').Level<string, unknown>} */
    const db = new Level(this.dbPath, levelOptions);
    this.db = db;
    await this.db.open();
  }

  async closeInternal() {
    for (const unsubscribe of this.subscriptions) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.subscriptions = [];
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    await this.destroyPrevoutWorkerPool();
    this.prevoutCache.clear();
  }

  resetSyncStats() {
    this.syncStats = createEmptySyncStats();
  }

  getSyncStats() {
    return {
      ...this.syncStats,
      prevoutWorkers: this.prevoutConcurrency,
      levelCacheBytes: this.levelCacheBytes,
      levelWriteBufferBytes: this.levelWriteBufferBytes,
      prevoutCacheMax: this.prevoutCacheMax,
      prevoutCacheTtl: this.prevoutCacheTtl,
      batchBlockCount: this.batchBlockCount,
      parallelPrevoutEnabled: this.parallelPrevoutEnabled
    };
  }

  async ensurePrevoutWorkerPool() {
    if (this.prevoutWorkerPoolDisabled || !this.parallelPrevoutEnabled || this.prevoutConcurrency <= 1) {
      return null;
    }
    if (this.prevoutWorkerPoolReady) {
      return this.prevoutWorkerPoolReady;
    }
    if (!PrevoutWorkerPool.isSupported()) {
      this.logger.info({ context: { event: 'addressIndexer.prevout.worker.unsupported' } }, 'Worker threads unavailable; using inline prevout fetch');
      this.prevoutWorkerPoolDisabled = true;
      this.prevoutWorkerPoolReady = Promise.resolve(null);
      return this.prevoutWorkerPoolReady;
    }
    const workerCount = Math.min(this.prevoutConcurrency, MAX_RECOMMENDED_CONCURRENCY);
    const pool = new PrevoutWorkerPool(workerCount, this.logger);
    this.prevoutWorkerPool = pool;
    this.prevoutWorkerPoolReady = pool.init()
      .then(() => pool)
      .catch((error) => {
        this.logger.warn({ context: { event: 'addressIndexer.prevout.worker.init.failure' }, err: error }, 'Failed to initialise prevout worker pool; falling back to inline fetch');
        this.prevoutWorkerPool = null;
        this.prevoutWorkerPoolDisabled = true;
        return null;
      });
    return this.prevoutWorkerPoolReady;
  }

  async getPrevoutWorkerPool() {
    if (this.prevoutWorkerPoolDisabled) {
      return null;
    }
    const ready = await this.ensurePrevoutWorkerPool();
    return ready ?? null;
  }

  async destroyPrevoutWorkerPool({ disable = false } = {}) {
    if (this.prevoutWorkerPool) {
      try {
        await this.prevoutWorkerPool.destroy();
      } catch (error) {
        this.logger.warn({ context: { event: 'addressIndexer.prevout.worker.destroy.error' }, err: error }, 'Failed to cleanly shutdown prevout worker pool');
      }
    }
    this.prevoutWorkerPool = null;
    this.prevoutWorkerPoolReady = null;
    if (disable) {
      this.prevoutWorkerPoolDisabled = true;
    }
  }

  async handlePrevoutWorkerPoolFailure(error) {
    this.logger.warn({ context: { event: 'addressIndexer.prevout.worker.failure' }, err: error }, 'Prevout worker pool failure; disabling pool and falling back to inline fetch');
    await this.destroyPrevoutWorkerPool({ disable: true });
  }

  registerSignalHandlers() {
    const handleSignal = async (signal) => {
      if (this.stopping) {
        return;
      }
      this.stopping = true;
      this.logger.info({ context: { event: 'addressIndexer.shutdown.signal', signal } }, 'Received shutdown signal; waiting for indexer to flush');
      try {
        await this.awaitSyncDrain();
      } catch (error) {
        this.logger.warn({ context: { event: 'addressIndexer.shutdown.flush.error', signal }, err: error }, 'Timed out flushing indexer before shutdown');
      }
      try {
        await this.closeInternal();
      } catch (closeError) {
        this.logger.warn({ context: { event: 'addressIndexer.shutdown.close.error', signal }, err: closeError }, 'Error closing indexer after shutdown signal');
      }
    };

    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = handleSignal.bind(this, signal);
      process.once(signal, handler);
      this.signalHandlers.push({ signal, handler });
    }
  }

  unregisterSignalHandlers() {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }

  async awaitSyncDrain(timeoutMs = 10_000) {
    const start = Date.now();
    while (this.syncInProgress) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for sync to finish');
      }
      await delay(50);
    }
    await this.syncChain.catch((error) => {
      this.logger.error({ context: { event: 'addressIndexer.syncChain.error' }, err: error }, 'Error in sync chain during drain');
    });
  }

  async getMetadata(key, fallback = null) {
    try {
      if (!this.db) {
        return fallback;
      }
      return await this.db.get(metaKey(key));
    } catch (error) {
      if (isNotFound(error)) {
        return fallback;
      }
      throw error;
    }
  }

  /**
   * @param {string} key
   * @param {unknown} value
   * @param {BatchOperation[]} [batch]
   */
  async setMetadata(key, value, batch) {
    const operation = /** @type {BatchPutOperation} */ ({ type: 'put', key: metaKey(key), value });
    if (batch) {
      batch.push(operation);
    } else if (this.db) {
      await this.db.put(operation.key, operation.value);
    }
  }

  async start() {
    if (this.db) {
      return;
    }
    this.stopping = false;
    await this.open();
    this.logger.info({
      context: {
        event: 'addressIndexer.start',
        dbPath: this.dbPath,
        gapLimit: this.gapLimit,
        prevoutConcurrency: this.prevoutConcurrency,
        prevoutCacheMax: this.prevoutCacheMax,
        prevoutCacheTtl: this.prevoutCacheTtl,
        levelCacheBytes: this.levelCacheBytes,
        levelWriteBufferBytes: this.levelWriteBufferBytes,
        batchBlockCount: this.batchBlockCount,
        parallelPrevoutEnabled: this.parallelPrevoutEnabled,
        workerThreads: isWorkerThreadsAvailable()
      }
    }, 'Address indexer starting');
    if (!this.parallelPrevoutEnabled && this.prevoutConcurrency > 1) {
      this.logger.info({
        context: {
          event: 'addressIndexer.prevout.parallel.disabled',
          configuredWorkers: this.prevoutConcurrency
        }
      }, 'Prevout parallelism disabled; falling back to sequential fetches despite configured worker count');
    } else if (this.prevoutConcurrency > MAX_RECOMMENDED_CONCURRENCY) {
      this.logger.warn({
        context: {
          event: 'addressIndexer.prevout.parallel.high',
          configuredWorkers: this.prevoutConcurrency,
          recommended: MAX_RECOMMENDED_CONCURRENCY
        }
      }, 'Prevout worker concurrency exceeds recommended maximum; monitor Core RPC load');
    }
    this.registerSignalHandlers();
    this.resetSyncStats();
    this.prevoutWorkerPoolDisabled = false;
    await this.ensurePrevoutWorkerPool();
    await this.initialSync();
    if (!this.stopping) {
      this.watchZmq();
    }
  }

  async initialSync() {
    const bestHeight = await rpcCall('getblockcount');
    const lastProcessed = Number(this.toNumberOrNull(await this.getMetadata('last_processed_height', -1)));
    let nextHeight = lastProcessed + 1;
    const startHeight = nextHeight;
    const totalBlocks = bestHeight - startHeight + 1;
    this.logger.info({
      context: {
        event: 'addressIndexer.sync.start',
        fromHeight: nextHeight,
        toHeight: bestHeight
      }
    }, 'Address index initial sync starting');

    const batchingEnabled = this.batchBlockCount > 1;
    let pendingOperations = [];
    let pendingBlocks = 0;
    let pendingTx = 0;
    let pendingHash = null;
    let pendingHeight = null;
    const batchSummaryCache = batchingEnabled ? new Map() : null;

    const flushPending = async () => {
      if (pendingBlocks === 0) {
        return;
      }
      await this.commitOperations(pendingOperations, {
        hash: pendingHash,
        height: pendingHeight,
        blocks: pendingBlocks,
        txCount: pendingTx
      });
      pendingOperations = [];
      pendingBlocks = 0;
      pendingTx = 0;
      pendingHash = null;
      pendingHeight = null;
      batchSummaryCache?.clear();
    };

    while (!this.stopping && nextHeight <= bestHeight) {
      this.syncInProgress = true;
      try {
        const result = await this.processBlockHeight(nextHeight, batchingEnabled ? { collect: true, summaryCache: batchSummaryCache } : undefined);
        if (batchingEnabled && result?.operations) {
          pendingOperations.push(...result.operations);
          pendingBlocks += 1;
          pendingTx += result.txCount ?? 0;
          pendingHash = result.hash ?? pendingHash;
          pendingHeight = result.height ?? pendingHeight;
          if (result.summaries && batchSummaryCache) {
            for (const [address, summary] of result.summaries.entries()) {
              batchSummaryCache.set(address, summary);
            }
          }
          if (pendingBlocks >= this.batchBlockCount) {
            await flushPending();
          }
        }
      } finally {
        this.syncInProgress = false;
      }
      if (totalBlocks > 0 && (nextHeight === bestHeight || nextHeight % 100 === 0)) {
        const processed = nextHeight - startHeight + 1;
        const remaining = Math.max(0, totalBlocks - processed);
        const percent = Math.round((processed / totalBlocks) * 100);
        this.logger.info({
          context: {
            event: 'addressIndexer.sync.progress',
            processed,
            total: totalBlocks,
            remaining,
            height: nextHeight,
            percent
          }
        }, `Address index sync progress ${processed}/${totalBlocks} (${percent}%)`);
      }
      nextHeight += 1;
    }

    if (batchingEnabled) {
      await flushPending();
    }

    if (this.stopping) {
      this.logger.info({
        context: {
          event: 'addressIndexer.sync.halted',
          lastProcessedHeight: nextHeight - 1
        }
      }, 'Address index initial sync halted before completion');
    } else {
      this.logger.info({
        context: {
          event: 'addressIndexer.sync.complete',
          height: bestHeight
        }
      }, 'Address index initial sync complete');
    }
  }

  async processBlockHeight(height, options = {}) {
    const hash = await rpcCall('getblockhash', [height]);
    return this.processBlockHash(hash, height, options);
  }

  async processBlockHash(hash, expectedHeight = null, options = {}) {
    const { collect = false, summaryCache = null } = options;
    if (this.stopping || !this.db) {
      this.logger.debug({ context: { event: 'addressIndexer.block.skip', hash, reason: this.db ? 'stopping' : 'db-closed' } }, 'Skipping block processing during shutdown');
      return;
    }

    const startedAt = now();
    let outcome = 'success';
    let height = expectedHeight;
    let txCount = 0;

    try {
      const block = await fetchBlockWithRetry(hash, this.logger);
      height = expectedHeight ?? block.height;
      const timestamp = block.time ?? null;
      /** @type {BatchOperation[]} */
      const operations = [];
      /** @type {Map<string, AddressSummary>} */
      const summaries = summaryCache ?? new Map();
      const localTouched = new Set();

      txCount = Array.isArray(block.tx) ? block.tx.length : 0;

      for (const transaction of block.tx || []) {
        const prevouts = await this.fetchPrevouts(transaction);
        const addressesSeen = new Set();

        // Outputs (inbound)
        for (const output of transaction.vout || []) {
          if (!output?.scriptPubKey) {
            continue;
          }
          const addresses = output.scriptPubKey.addresses || (output.scriptPubKey.address ? [output.scriptPubKey.address] : []);
          if (!Array.isArray(addresses) || addresses.length === 0) {
            continue;
          }
          const valueSat = sats(output.value ?? 0);
          for (const address of addresses) {
            const summary = await this.getSummaryForMutation(address, height, summaries);
            if (!addressesSeen.has(address)) {
              summary.txCount += 1;
              addressesSeen.add(address);
            }
            if (typeof height === 'number') {
              summary.lastSeenHeight = summary.lastSeenHeight != null ? Math.max(summary.lastSeenHeight, height) : height;
              summary.firstSeenHeight = summary.firstSeenHeight != null ? Math.min(summary.firstSeenHeight, height) : height;
            }
            summary.totalReceivedSat += valueSat;
            summary.balanceSat += valueSat;
            summary.utxoCount += 1;
            summary.utxoValueSat += valueSat;
            localTouched.add(address);

            operations.push(/** @type {BatchPutOperation} */ ({
              type: 'put',
              key: utxoKey(address, transaction.txid, output.n ?? 0),
              value: /** @type {AddressUtxoRecord} */ ({
                address,
                txid: transaction.txid,
                vout: output.n ?? 0,
                valueSat,
                height
              })
            }));
              operations.push(/** @type {BatchPutOperation} */ ({
                type: 'put',
                key: txKey(address, height, DIRECTION_IN, output.n ?? 0, transaction.txid),
                value: /** @type {AddressTxRecord} */ ({
                  address,
                  txid: transaction.txid,
                  height,
                  direction: DIRECTION_IN,
                  valueSat,
                  ioIndex: output.n ?? 0,
                  timestamp
                })
              }));
            }
          }

        // Inputs (outbound)
        for (const [index, input] of (transaction.vin || []).entries()) {
          if (input.coinbase) {
            continue;
          }
          const prevout = prevouts[index];
          if (!prevout) {
            continue;
          }
          const valueSat = sats(prevout.value ?? 0);
          const addresses = prevout.scriptPubKey?.addresses || (prevout.scriptPubKey?.address ? [prevout.scriptPubKey.address] : []);
          for (const address of addresses) {
            const summary = await this.getSummaryForMutation(address, height, summaries);
            const incrementTx = !addressesSeen.has(address);
            if (incrementTx) {
              addressesSeen.add(address);
            }
            this.applyOutbound({
              address,
              currentTxid: transaction.txid,
              prevTxid: input.txid,
              prevVout: input.vout ?? 0,
              valueSat,
              height,
              timestamp,
              incrementTx,
              summary,
              touchedSummaries: localTouched
            }, operations);
          }
        }
      }

      for (const address of localTouched) {
        const summary = summaries.get(address);
        if (!summary) {
          continue;
        }
        operations.push(/** @type {BatchPutOperation} */ ({
          type: 'put',
          key: summaryKey(address),
          value: sanitizeSummary(summary)
        }));
      }

      await this.setMetadata('last_processed_hash', hash, operations);
      await this.setMetadata('last_processed_height', height, operations);

      this.syncStats.blocksProcessed += 1;
      this.syncStats.transactionsProcessed += txCount;

      if (collect) {
        return { operations, height, txCount, hash, summaries: summaryCache ?? summaries };
      }

      await this.commitOperations(operations, {
        hash,
        height,
        blocks: 1,
        txCount
      });
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      const totalDuration = durationMs(startedAt);
      this.logger.debug({
        context: {
          event: 'addressIndexer.block.duration',
          hash,
          height,
          txCount,
          outcome,
          durationMs: totalDuration
        }
      }, 'Address indexer block timing sample');
      metrics.recordAddressIndexerBlockDuration({ outcome, durationMs: totalDuration });
    }
  }

  async commitOperations(operations, { hash, height, blocks = 1, txCount = 0 }) {
    if (!operations?.length || !this.db) {
      return;
    }
    const batchStartedAt = now();
    await this.db.batch(operations);
    const batchDuration = durationMs(batchStartedAt);
    this.logger.debug({
      context: {
        event: 'addressIndexer.db.batch.duration',
        hash,
        height,
        blocks,
        txCount,
        operations: operations.length,
        durationMs: batchDuration
      }
    }, 'Address indexer committed LevelDB batch');
  }

  /**
   * @param {string} address
   * @param {number|null} height
   * @param {Map<string, AddressSummary>} cache
   * @returns {Promise<AddressSummary>}
   */
  async getSummaryForMutation(address, height, cache) {
    if (cache.has(address)) {
      return cache.get(address);
    }
    /** @type {AddressSummary} */
    /** @type {AddressSummary | undefined} */
    let summary;
    try {
      summary = /** @type {AddressSummary} */ (await this.db.get(summaryKey(address)));
    } catch (error) {
      if (isNotFound(error)) {
        summary = createSummary(address, height);
      } else {
        throw error;
      }
    }
    if (!summary) {
      summary = createSummary(address, height);
    }
    if (typeof height === 'number') {
      summary.firstSeenHeight = summary.firstSeenHeight != null ? Math.min(summary.firstSeenHeight, height) : height;
      summary.lastSeenHeight = summary.lastSeenHeight != null ? Math.max(summary.lastSeenHeight, height) : height;
    }
    cache.set(address, summary);
    return summary;
  }

  /**
   * @param {{
   *  address: string;
   *  currentTxid: string;
   *  prevTxid: string;
  *  prevVout: number;
  *  valueSat: number;
  *  height: number | null;
  *  timestamp: number | null;
  *  incrementTx: boolean;
  *  summary: AddressSummary;
  *  touchedSummaries?: Set<string>;
  * }} payload
   * @param {BatchOperation[]} operations
   */
  applyOutbound({ address, currentTxid, prevTxid, prevVout, valueSat, height, timestamp, incrementTx, summary, touchedSummaries }, operations) {
    summary.totalSentSat += valueSat;
    summary.balanceSat -= valueSat;
    summary.utxoCount = Math.max(0, summary.utxoCount - 1);
    summary.utxoValueSat = Math.max(0, summary.utxoValueSat - valueSat);
    if (incrementTx) {
      summary.txCount += 1;
    }
    if (typeof height === 'number') {
      summary.lastSeenHeight = summary.lastSeenHeight != null ? Math.max(summary.lastSeenHeight, height) : height;
    }
    touchedSummaries?.add(address);

    operations.push(/** @type {BatchDelOperation} */ ({
      type: 'del',
      key: utxoKey(address, prevTxid, prevVout)
    }));
    operations.push(/** @type {BatchPutOperation} */ ({
      type: 'put',
      key: txKey(address, height, DIRECTION_OUT, prevVout, currentTxid),
      value: /** @type {AddressTxRecord} */ ({
        address,
        txid: currentTxid,
        height,
        direction: DIRECTION_OUT,
        valueSat,
        ioIndex: prevVout,
        timestamp
      })
    }));
  }

  async fetchPrevouts(transaction) {
    const startedAt = now();
    const vin = Array.isArray(transaction?.vin) ? transaction.vin : [];
    const inputs = vin.length;
    const results = new Array(inputs).fill(null);
    let cacheHits = 0;
    let rpcCalls = 0;

    const pool = await this.getPrevoutWorkerPool();
    let workerActive = Boolean(pool);

    const workerPayloads = [];
    const workerIndices = [];
    const fallbackInputs = [];
    const fallbackIndices = [];

    for (let index = 0; index < vin.length; index += 1) {
      const input = vin[index];
      if (!input || input.coinbase) {
        results[index] = null;
        continue;
      }
      const key = `${input.txid}:${input.vout}`;
      const cached = this.prevoutCache.get(key);
      if (cached) {
        cacheHits += 1;
        results[index] = cached;
        continue;
      }
      if (pool) {
        workerPayloads.push({ txid: input.txid, vout: input.vout });
        workerIndices.push(index);
      } else {
        fallbackInputs.push(input);
        fallbackIndices.push(index);
      }
    }

    if (pool && workerPayloads.length > 0) {
      try {
        const workerResults = await pool.fetchMany(workerPayloads);
        rpcCalls += workerPayloads.length;
        for (let i = 0; i < workerResults.length; i += 1) {
          const result = workerResults[i];
          const index = workerIndices[i];
          const input = vin[index];
          const key = `${input.txid}:${input.vout}`;
          if (result.status === 'ok') {
            const prevout = result.prevout ?? null;
            if (prevout) {
              this.prevoutCache.set(key, prevout);
            }
            results[index] = prevout;
          } else {
            this.logger.warn({
              context: {
                event: 'addressIndexer.prevout.worker.error',
                txid: input.txid,
                vout: input.vout
              },
              err: result.error
            }, 'Prevout worker task failed; retrying inline');
            fallbackInputs.push(input);
            fallbackIndices.push(index);
            rpcCalls -= 1; // will account for retry below
          }
        }
      } catch (error) {
        workerActive = false;
        await this.handlePrevoutWorkerPoolFailure(error);
        for (let i = 0; i < workerPayloads.length; i += 1) {
          const index = workerIndices[i];
          fallbackInputs.push(vin[index]);
          fallbackIndices.push(index);
        }
      }
    }

    if (fallbackInputs.length > 0) {
      const inlineStats = await this.fetchPrevoutsInline(fallbackInputs, fallbackIndices, results);
      cacheHits += inlineStats.cacheHits;
      rpcCalls += inlineStats.rpcCalls;
    }

    const duration = durationMs(startedAt);
    this.syncStats.prevoutCacheHits += cacheHits;
    this.syncStats.prevoutRpcCalls += rpcCalls;
    const source = rpcCalls > 0 ? (cacheHits > 0 ? 'mixed' : 'rpc') : 'cache';
    this.logger.debug({
      context: {
        event: 'addressIndexer.prevout.duration',
        txid: transaction?.txid,
        inputs,
        cacheHits,
        rpcCalls,
        concurrency: this.prevoutConcurrency,
        workerPool: workerActive,
        durationMs: duration
      }
    }, 'Address indexer prevout fetch timing sample');
    metrics.recordAddressIndexerPrevoutDuration({ source, durationMs: duration });
    return results;
  }

  async fetchPrevoutsInline(inputs, indices, results) {
    let cacheHits = 0;
    let rpcCalls = 0;

    const fetchPrevout = async (input, index) => {
      if (!input) {
        results[index] = null;
        return;
      }
      const key = `${input.txid}:${input.vout}`;
      const cached = this.prevoutCache.get(key);
      if (cached) {
        cacheHits += 1;
        results[index] = cached;
        return;
      }
      try {
        rpcCalls += 1;
        this.logger.debug({ context: { event: 'addressIndexer.prevout.fetch', txid: input.txid } }, 'Fetching prevout via RPC');
        const prevTx = await rpcCall('getrawtransaction', [input.txid, true]);
        const prevout = prevTx?.vout?.find((output) => output.n === input.vout) || null;
        if (prevout) {
          this.prevoutCache.set(key, prevout);
        }
        results[index] = prevout;
      } catch (error) {
        this.logger.warn({ context: { event: 'addressIndexer.prevout.error', txid: input.txid }, err: error }, 'Failed to fetch prevout');
        results[index] = null;
      }
    };

    const useParallel = this.parallelPrevoutEnabled && this.prevoutConcurrency > 1 && (!this.prevoutWorkerPool || this.prevoutWorkerPoolDisabled);
    if (useParallel) {
      const tasks = inputs.map((input, idx) => () => fetchPrevout(input, indices[idx]));
      await runWithConcurrency(tasks, this.prevoutConcurrency);
    } else {
      for (let i = 0; i < inputs.length; i += 1) {
        await fetchPrevout(inputs[i], indices[i]);
      }
    }

    return { cacheHits, rpcCalls };
  }

  watchZmq() {
    const unsubscribeBlock = subscribe(CacheEvents.BLOCK_NEW, ({ hash }) => {
      this.logger.debug({ context: { event: 'addressIndexer.zmq.block', hash } }, 'Received block notification from ZMQ');
      this.syncChain = this.syncChain
        .then(async () => {
          if (this.stopping) {
            return;
          }
          this.syncInProgress = true;
          try {
            await this.processBlockHash(hash);
            this.logger.debug({ context: { event: 'addressIndexer.block.applied', hash } }, 'Address indexer applied new block');
          } catch (error) {
            this.logger.error({ context: { event: 'addressIndexer.block.error', hash }, err: error }, 'Failed to process new block');
          } finally {
            this.syncInProgress = false;
          }
        })
        .catch((error) => {
          this.logger.error({ context: { event: 'addressIndexer.syncChain.error' }, err: error }, 'Error in sync chain');
        });
    });

    this.subscriptions.push(unsubscribeBlock);
  }

  async shutdown() {
    if (this.stopping) {
      await this.awaitSyncDrain().catch(() => {});
      return;
    }
    this.stopping = true;
    await this.awaitSyncDrain().catch(() => {});
    this.unregisterSignalHandlers();
    await this.closeInternal();
  }

  // Query helpers
  async getAddressSummary(address) {
    try {
      const summary = /** @type {AddressSummary} */ (await this.db.get(summaryKey(address)));
      return summary;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async getAddressTransactions(address, { page = 1, pageSize = 25 }) {
    const safePageSize = Math.max(1, pageSize);
    const safePage = Math.max(1, page);
    const { gte, lt } = prefixRange(`${PREFIXES.TX}${address}!`);
    const iterator = this.db.iterator({ gte, lt, reverse: true });
    /** @type {AddressTxRecord[]} */
    const rows = [];
    let totalRows = 0;
    const startIndex = (safePage - 1) * safePageSize;

    try {
      for await (const [, value] of iterator) {
        totalRows += 1;
        if (totalRows <= startIndex) {
          continue;
        }
        if (rows.length < safePageSize) {
          rows.push(/** @type {AddressTxRecord} */ (value));
        } else {
          break;
        }
      }
    } finally {
      await iterator.close();
    }

    return {
      rows,
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        totalRows
      }
    };
  }

  async getAddressUtxos(address) {
    const { gte, lt } = prefixRange(`${PREFIXES.UTXO}${address}!`);
    const iterator = this.db.iterator({ gte, lt });
    /** @type {AddressUtxoRecord[]} */
    const utxos = [];
    try {
      for await (const [, value] of iterator) {
        utxos.push(/** @type {AddressUtxoRecord} */ (value));
      }
    } finally {
      await iterator.close();
    }
    utxos.sort((a, b) => b.valueSat - a.valueSat);
    return utxos;
  }

  toNumberOrNull(value) {
    if (value == null) {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}

export async function startAddressIndexer() {
  if (!config.address.enabled) {
    return null;
  }
  if (!singletonIndexer) {
    singletonIndexer = new AddressIndexer({
      dbPath: path.resolve(config.address.indexPath),
      gapLimit: config.address.xpubGapLimit,
      logger: getLogger().child({ module: 'address-indexer' })
    });
    await singletonIndexer.start();
  }
  return singletonIndexer;
}

export function getAddressIndexer() {
  return singletonIndexer;
}

export async function stopAddressIndexer() {
  if (singletonIndexer) {
    await singletonIndexer.shutdown();
    singletonIndexer = null;
  }
}
