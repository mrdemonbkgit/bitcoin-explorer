import { performance } from 'node:perf_hooks';
import path from 'node:path';
import fs from 'node:fs';
import { AddressIndexer } from '../../src/infra/addressIndexer.js';
import { getLogger } from '../../src/infra/logger.js';
import { rpcCall } from '../../src/rpc.js';

/** @type {string[] | null} */
const PRESEEDED_ADDRESSES = process.env.BENCH_PRESEEDED_ADDRESSES
  ? JSON.parse(process.env.BENCH_PRESEEDED_ADDRESSES)
  : null;
const BACKEND_LABEL = process.env.BENCH_BACKEND ?? 'leveldb';

/**
 * @typedef {Object} BenchOptions
 * @property {number} sample
 * @property {number} warmups
 * @property {number} iterations
 * @property {string | null} output
 */

/**
 * @param {string[]} argv
 * @returns {BenchOptions}
 */
function parseArgs(argv) {
  /** @type {BenchOptions} */
  const options = {
    sample: 100,
    warmups: 0,
    iterations: 1,
    output: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sample') {
      options.sample = Number(argv[++i] ?? options.sample);
    } else if (arg === '--warmups') {
      options.warmups = Number(argv[++i] ?? options.warmups);
    } else if (arg === '--iterations') {
      options.iterations = Number(argv[++i] ?? options.iterations);
    } else if (arg === '--output') {
      options.output = argv[++i] ?? null;
    }
  }
  return options;
}

async function collectSampleAddresses(indexer, sampleSize) {
  if (Array.isArray(PRESEEDED_ADDRESSES) && PRESEEDED_ADDRESSES.length > 0) {
    return PRESEEDED_ADDRESSES.slice(0, sampleSize);
  }
  if (!indexer.db) {
    return [];
  }
  const addresses = [];
  const iterator = indexer.db.iterator({ gte: 'addr!', lt: 'addr!\uFFFF' });
  try {
    for await (const [, value] of iterator) {
      const record = /** @type {{ address?: string }} */ (value);
      if (record?.address) {
        addresses.push(record.address);
      }
      if (addresses.length >= sampleSize) {
        break;
      }
    }
  } finally {
    await iterator.close();
  }
  return addresses;
}

async function measureReads(indexer, addresses, iterations) {
  const summaries = [];
  const transactions = [];
  const utxos = [];
  const results = {
    summaryMs: 0,
    transactionsMs: 0,
    utxosMs: 0,
    iterations,
    addressesTested: addresses.length
  };

  for (let iter = 0; iter < iterations; iter += 1) {
    const summaryStart = performance.now();
    for (const address of addresses) {
      const summary = await indexer.getAddressSummary(address);
      summaries.push(summary);
    }
    results.summaryMs += performance.now() - summaryStart;

    const txStart = performance.now();
    for (const address of addresses) {
      const data = await indexer.getAddressTransactions(address, { page: 1, pageSize: 25 });
      transactions.push(data);
    }
    results.transactionsMs += performance.now() - txStart;

    const utxoStart = performance.now();
    for (const address of addresses) {
      const data = await indexer.getAddressUtxos(address);
      utxos.push(data);
    }
    results.utxosMs += performance.now() - utxoStart;
  }

  return results;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBooleanEnv(value) {
  if (value == null) {
    return null;
  }
  const normalised = value.trim().toLowerCase();
  if (normalised === '') {
    return false;
  }
  if (['true', '1', 'yes', 'y', 'on'].includes(normalised)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalised)) {
    return false;
  }
  return null;
}

async function run() {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  const logger = getLogger().child({ module: 'address-indexer-bench' });
  const dbPath = process.env.ADDRESS_INDEX_PATH ? path.resolve(process.env.ADDRESS_INDEX_PATH) : path.resolve('./data/address-index');

  if (fs.existsSync(dbPath)) {
    logger.info({ context: { event: 'bench.cleanup', path: dbPath } }, 'Removing existing index path before benchmark');
    fs.rmSync(dbPath, { recursive: true, force: true });
  }

  const indexer = new AddressIndexer({
    dbPath,
    logger: getLogger().child({ module: 'address-indexer', scope: 'bench' })
  });

  const ingestStart = performance.now();
  await indexer.start();
  const ingestMs = performance.now() - ingestStart;

  const bestHeight = await rpcCall('getblockcount');
  const syncStats = typeof indexer.getSyncStats === 'function' ? indexer.getSyncStats() : null;
  const sampleAddresses = await collectSampleAddresses(indexer, options.sample);

  if (options.warmups > 0 && sampleAddresses.length > 0) {
    for (let i = 0; i < options.warmups; i += 1) {
      await measureReads(indexer, sampleAddresses, 1);
    }
  }

  const readMetrics = sampleAddresses.length > 0 ? await measureReads(indexer, sampleAddresses, options.iterations) : {
    summaryMs: 0,
    transactionsMs: 0,
    utxosMs: 0,
    iterations: options.iterations,
    addressesTested: 0
  };

  const legacyIndexer = /** @type {any} */ (indexer);
  if (typeof legacyIndexer.shutdown === 'function') {
    await legacyIndexer.shutdown();
  } else if (typeof legacyIndexer.close === 'function') {
    await legacyIndexer.close();
  }

  const blocksProcessed = syncStats?.blocksProcessed ?? 0;
  const transactionsProcessed = syncStats?.transactionsProcessed ?? 0;
  const prevoutCacheHits = syncStats?.prevoutCacheHits ?? 0;
  const prevoutRpcCalls = syncStats?.prevoutRpcCalls ?? 0;
  const ingestSeconds = ingestMs / 1000;
  const throughput = {
    blocksPerSecond: ingestSeconds > 0 ? blocksProcessed / ingestSeconds : 0,
    transactionsPerSecond: ingestSeconds > 0 ? transactionsProcessed / ingestSeconds : 0
  };

  const settings = {
    prevoutConcurrency: toNumber(process.env.ADDRESS_INDEXER_CONCURRENCY) ?? syncStats?.prevoutWorkers ?? null,
    prevoutCacheMax: toNumber(process.env.ADDRESS_PREVOUT_CACHE_MAX) ?? syncStats?.prevoutCacheMax ?? null,
    prevoutCacheTtlMs: toNumber(process.env.ADDRESS_PREVOUT_CACHE_TTL) ?? syncStats?.prevoutCacheTtl ?? null,
    levelCacheMb: toNumber(process.env.ADDRESS_LEVEL_CACHE_MB) ?? (syncStats?.levelCacheBytes ? syncStats.levelCacheBytes / (1024 * 1024) : null),
    levelWriteBufferMb: toNumber(process.env.ADDRESS_LEVEL_WRITE_BUFFER_MB) ?? (syncStats?.levelWriteBufferBytes ? syncStats.levelWriteBufferBytes / (1024 * 1024) : null),
    batchBlocks: toNumber(process.env.ADDRESS_INDEXER_BATCH_BLOCKS) ?? syncStats?.batchBlockCount ?? null,
    parallelPrevoutEnabled: (() => {
      const parsed = parseBooleanEnv(process.env.ADDRESS_INDEXER_PARALLEL_ENABLED);
      if (parsed != null) {
        return parsed;
      }
      if (typeof syncStats?.parallelPrevoutEnabled === 'boolean') {
        return syncStats.parallelPrevoutEnabled;
      }
      return null;
    })(),
    rpcMaxSockets: toNumber(process.env.BITCOIN_RPC_MAX_SOCKETS) ?? null
  };

  const result = {
    backend: BACKEND_LABEL,
    chainHeight: bestHeight,
    ingestMs,
    ingestSeconds,
    sampleCount: sampleAddresses.length,
    iterations: options.iterations,
    settings,
    sync: {
      blocksProcessed,
      transactionsProcessed,
      prevoutCacheHits,
      prevoutRpcCalls
    },
    throughput,
    reads: {
      summaryMs: readMetrics.summaryMs,
      transactionsMs: readMetrics.transactionsMs,
      utxosMs: readMetrics.utxosMs,
      summaryAvgMs: readMetrics.addressesTested > 0 ? readMetrics.summaryMs / (readMetrics.addressesTested * options.iterations) : 0,
      transactionsAvgMs: readMetrics.addressesTested > 0 ? readMetrics.transactionsMs / (readMetrics.addressesTested * options.iterations) : 0,
      utxosAvgMs: readMetrics.addressesTested > 0 ? readMetrics.utxosMs / (readMetrics.addressesTested * options.iterations) : 0
    }
  };

  if (options.output) {
    const outputPath = options.output;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  }

  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
