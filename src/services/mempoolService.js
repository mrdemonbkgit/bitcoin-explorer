import { createCache } from '../cache.js';
import { rpcCall } from '../rpc.js';
import { config } from '../config.js';
import { CacheEvents, subscribe } from '../infra/cacheEvents.js';
import { metrics } from '../infra/metrics.js';

const MEMPOOL_PAGE_SIZE = 25;
const SATS_IN_BTC = 100_000_000;
const FEE_BUCKETS = [
  { label: '0-1', min: 0, max: 1 },
  { label: '1-5', min: 1, max: 5 },
  { label: '5-10', min: 5, max: 10 },
  { label: '10-20', min: 10, max: 20 },
  { label: '20-50', min: 20, max: 50 },
  { label: '50+', min: 50, max: Infinity }
];

const mempoolCache = createCache(config.cache.mempool, { name: 'mempool', metrics });

subscribe(CacheEvents.BLOCK_NEW, () => {
  mempoolCache.clear();
});

subscribe(CacheEvents.TX_NEW, () => {
  mempoolCache.clear();
});

function toNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function deriveFeeRate(entry) {
  const vsize = entry.vsize ?? entry.size ?? null;
  if (!vsize || vsize <= 0) {
    return null;
  }

  if (typeof entry.fee === 'number') {
    return (entry.fee * SATS_IN_BTC) / vsize;
  }
  if (entry.fees && typeof entry.fees.base === 'number') {
    return (entry.fees.base * SATS_IN_BTC) / vsize;
  }
  return null;
}

function buildHistogram(entries) {
  const buckets = FEE_BUCKETS.map((bucket) => ({
    range: bucket.label,
    count: 0,
    vsize: 0
  }));

  for (const entry of entries) {
    if (entry.feerate == null) {
      continue;
    }
    const target = buckets.find((bucket, index) => {
      const { min, max } = FEE_BUCKETS[index];
      const feerate = entry.feerate;
      if (max === Infinity) {
        return feerate >= min;
      }
      if (feerate === min && min !== 0) {
        return true;
      }
      return feerate >= min && feerate < max;
    });
    if (target) {
      target.count += 1;
      target.vsize += entry.vsize;
    }
  }

  return buckets;
}

function medianFeeRate(entries) {
  const rates = entries
    .map((entry) => entry.feerate)
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);

  if (rates.length === 0) {
    return null;
  }
  const middle = Math.floor(rates.length / 2);
  if (rates.length % 2 === 0) {
    return (rates[middle - 1] + rates[middle]) / 2;
  }
  return rates[middle];
}

async function loadMempoolData() {
  const [info, rawEntries] = await Promise.all([
    rpcCall('getmempoolinfo'),
    rpcCall('getrawmempool', [true])
  ]);

  const nowSeconds = Date.now() / 1000;
  const entries = Object.entries(rawEntries).map(([txid, details]) => {
    const feerate = deriveFeeRate(details);
    const vsize = toNumber(details.vsize ?? details.size, 0);
    const ageSeconds = details.time ? Math.max(0, nowSeconds - Number(details.time)) : null;
    const isRbf = Boolean(details['bip125-replaceable']);

    return {
      txid,
      feerate,
      vsize,
      ageSeconds,
      fee: typeof details.fee === 'number' ? details.fee : null,
      isRbf
    };
  });

  entries.sort((a, b) => {
    const ageA = a.ageSeconds ?? Number.POSITIVE_INFINITY;
    const ageB = b.ageSeconds ?? Number.POSITIVE_INFINITY;
    return ageA - ageB;
  });

  const histogram = buildHistogram(entries);
  const median = medianFeeRate(entries);

  return {
    updatedAt: new Date(),
    txCount: info.size ?? entries.length,
    virtualSize: info.bytes ?? entries.reduce((acc, entry) => acc + entry.vsize, 0),
    medianFee: median,
    histogram,
    entries
  };
}

export async function getMempoolViewModel(page = 1) {
  const snapshot = await mempoolCache.fetch('snapshot', loadMempoolData);
  const totalPages = Math.max(1, Math.ceil(snapshot.entries.length / MEMPOOL_PAGE_SIZE));
  const numericPage = Number(page);
  const safePage = Number.isFinite(numericPage) && numericPage >= 1 ? Math.min(numericPage, totalPages) : 1;
  const start = (safePage - 1) * MEMPOOL_PAGE_SIZE;
  const end = start + MEMPOOL_PAGE_SIZE;
  const recent = snapshot.entries.slice(start, end).map((entry) => ({
    txid: entry.txid,
    feerate: entry.feerate != null ? Number(entry.feerate.toFixed(2)) : null,
    vsize: entry.vsize,
    ageSeconds: entry.ageSeconds != null ? Math.round(entry.ageSeconds) : null,
    isRbf: entry.isRbf,
    fee: entry.fee
  }));

  return {
    snapshot: {
      updatedAt: snapshot.updatedAt.toISOString(),
      txCount: snapshot.txCount,
      virtualSize: snapshot.virtualSize,
      medianFee: snapshot.medianFee != null ? Number(snapshot.medianFee.toFixed(2)) : null,
      histogram: snapshot.histogram,
      recent
    },
    pagination: {
      page: safePage,
      pageSize: MEMPOOL_PAGE_SIZE,
      totalPages
    }
  };
}
