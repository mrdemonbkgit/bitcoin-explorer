import { performance } from 'node:perf_hooks';
import path from 'node:path';
import fs from 'node:fs';
import { AddressIndexer } from '../../src/infra/addressIndexer.js';
import { getLogger } from '../../src/infra/logger.js';
import { rpcCall } from '../../src/rpc.js';

function parseArgs(argv) {
  /** @type {Record<string, string | number | boolean>} */
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

  await indexer.shutdown();

  const result = {
    backend: 'leveldb',
    chainHeight: bestHeight,
    ingestMs,
    ingestSeconds: ingestMs / 1000,
    sampleCount: sampleAddresses.length,
    iterations: options.iterations,
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
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, JSON.stringify(result, null, 2));
  }

  console.log(JSON.stringify(result, null, 2));
}

run().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exitCode = 1;
});
