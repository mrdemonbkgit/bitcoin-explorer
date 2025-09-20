import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Level } from 'level';
import { config } from '../config.js';
import { getLogger } from './logger.js';
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
    this.prevoutCache = new Map();
    this.stopping = false;
    this.signalHandlers = [];
    this.syncInProgress = false;
    this.syncChain = Promise.resolve();
  }

  async open() {
    ensureDirectory(this.dbPath);
    /** @type {import('level').Level<string, unknown>} */
    const db = new Level(this.dbPath, { valueEncoding: 'json' });
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
    this.prevoutCache.clear();
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
    this.registerSignalHandlers();
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

    while (!this.stopping && nextHeight <= bestHeight) {
      this.syncInProgress = true;
      try {
        await this.processBlockHeight(nextHeight);
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

  async processBlockHeight(height) {
    const hash = await rpcCall('getblockhash', [height]);
    await this.processBlockHash(hash, height);
  }

  async processBlockHash(hash, expectedHeight = null) {
    if (this.stopping || !this.db) {
      this.logger.debug({ context: { event: 'addressIndexer.block.skip', hash, reason: this.db ? 'stopping' : 'db-closed' } }, 'Skipping block processing during shutdown');
      return;
    }

    const block = await fetchBlockWithRetry(hash, this.logger);
    const height = expectedHeight ?? block.height;
    const timestamp = block.time ?? null;
    /** @type {BatchOperation[]} */
    const operations = [];
    /** @type {Map<string, AddressSummary>} */
    const summaries = new Map();

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
            summary
          }, operations);
        }
      }
    }

    for (const [address, summary] of summaries.entries()) {
      operations.push(/** @type {BatchPutOperation} */ ({
        type: 'put',
        key: summaryKey(address),
        value: sanitizeSummary(summary)
      }));
    }

    await this.setMetadata('last_processed_hash', hash, operations);
    await this.setMetadata('last_processed_height', height, operations);
    await this.db.batch(operations);
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
   * }} payload
   * @param {BatchOperation[]} operations
   */
  applyOutbound({ address, currentTxid, prevTxid, prevVout, valueSat, height, timestamp, incrementTx, summary }, operations) {
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
    const results = [];
    for (const input of transaction.vin || []) {
      if (input.coinbase) {
        results.push(null);
        continue;
      }
      const key = `${input.txid}:${input.vout}`;
      if (this.prevoutCache.has(key)) {
        results.push(this.prevoutCache.get(key));
        continue;
      }
      try {
        this.logger.debug({ context: { event: 'addressIndexer.prevout.fetch', txid: input.txid } }, 'Fetching prevout via RPC');
        const prevTx = await rpcCall('getrawtransaction', [input.txid, true]);
        const prevout = prevTx?.vout?.find((output) => output.n === input.vout) || null;
        if (prevout) {
          this.prevoutCache.set(key, prevout);
        }
        results.push(prevout);
      } catch (error) {
        this.logger.warn({ context: { event: 'addressIndexer.prevout.error', txid: input.txid }, err: error }, 'Failed to fetch prevout');
        results.push(null);
      }
    }
    return results;
  }

  watchZmq() {
    const unsubscribeBlock = subscribe(CacheEvents.BLOCK_NEW, ({ hash }) => {
      this.syncChain = this.syncChain
        .then(async () => {
          if (this.stopping) {
            return;
          }
          this.syncInProgress = true;
          try {
            await this.processBlockHash(hash);
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
