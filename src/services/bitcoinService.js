import { createCache } from '../cache.js';
import { rpcCall } from '../rpc.js';
import { config } from '../config.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { CacheEvents, subscribe } from '../infra/cacheEvents.js';
import { metrics } from '../infra/metrics.js';

const tipCache = createCache(config.cache.tip, { name: 'tip', metrics });
const blockCache = createCache(config.cache.block, { name: 'block', metrics });
const txCache = createCache(config.cache.tx, { name: 'tx', metrics });

export const BLOCK_PAGE_SIZE = 25;
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const DIGITS = /^[0-9]+$/;

subscribe(CacheEvents.BLOCK_NEW, ({ hash }) => {
  tipCache.clear();
  if (typeof hash === 'string' && hash.length > 0) {
    blockCache.delete(hash.toLowerCase());
  }
});

subscribe(CacheEvents.TX_NEW, ({ txid }) => {
  if (typeof txid === 'string' && txid.length > 0) {
    txCache.delete(txid.toLowerCase());
  }
});

function resolveVinValue(vin) {
  if (!vin || vin.coinbase) {
    return 0;
  }
  if (typeof vin.value === 'number') {
    return vin.value;
  }
  if (vin.prevout && typeof vin.prevout.value === 'number') {
    return vin.prevout.value;
  }
  return 0;
}

function toNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestError('Height must be a finite integer');
  }
  return parsed;
}

function normaliseFee(response) {
  return typeof response?.feerate === 'number' ? response.feerate : null;
}

export async function getTipData() {
  return tipCache.fetch('summary', async () => {
    const [blockchainInfo, mempoolInfo, fee1, fee3, fee6] = await Promise.all([
      rpcCall('getblockchaininfo'),
      rpcCall('getmempoolinfo'),
      rpcCall('estimatesmartfee', [1]),
      rpcCall('estimatesmartfee', [3]),
      rpcCall('estimatesmartfee', [6])
    ]);

    return {
      chain: blockchainInfo.chain,
      height: blockchainInfo.blocks,
      bestHash: blockchainInfo.bestblockhash,
      mempool: {
        txCount: mempoolInfo.size,
        bytes: mempoolInfo.bytes
      },
      feeEstimates: {
        1: normaliseFee(fee1),
        3: normaliseFee(fee3),
        6: normaliseFee(fee6)
      }
    };
  });
}

async function resolveBlockHash(id) {
  if (HEX_64.test(id)) {
    return id.toLowerCase();
  }
  if (!DIGITS.test(id)) {
    throw new BadRequestError('Block id must be a height or 64-character hash');
  }
  const height = toNumber(id);
  return rpcCall('getblockhash', [height]);
}

async function fetchBlock(hash) {
  const key = hash.toLowerCase();
  return blockCache.fetch(key, async () => rpcCall('getblock', [hash, 2]));
}

export async function getBlockData(id, page = 1) {
  const hash = await resolveBlockHash(id);
  const block = await fetchBlock(hash);

  const totalTransactions = Array.isArray(block.tx) ? block.tx.length : 0;
  const totalPages = Math.max(1, Math.ceil(totalTransactions / BLOCK_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (safePage - 1) * BLOCK_PAGE_SIZE;
  const end = start + BLOCK_PAGE_SIZE;
  const txids = (block.tx || []).slice(start, end).map((tx) => tx.txid);

  return {
    hash: block.hash,
    height: block.height,
    timestamp: block.time ?? null,
    size: block.size,
    weight: block.weight,
    version: block.version,
    bits: block.bits,
    difficulty: block.difficulty,
    previousBlockHash: block.previousblockhash || null,
    nextBlockHash: block.nextblockhash || null,
    txCount: totalTransactions,
    txids,
    pagination: {
      page: safePage,
      totalPages,
      pageSize: BLOCK_PAGE_SIZE
    }
  };
}

export async function getTransactionData(txid) {
  if (!HEX_64.test(txid)) {
    throw new BadRequestError('Transaction id must be a 64-character hex string');
  }

  const tx = await txCache.fetch(txid.toLowerCase(), async () => rpcCall('getrawtransaction', [txid, 2]));

  if (!tx) {
    throw new NotFoundError('Transaction not found');
  }

  const inputValue = (tx.vin || []).reduce((acc, vin) => acc + resolveVinValue(vin), 0);
  const outputValue = (tx.vout || []).reduce((acc, vout) => acc + (typeof vout.value === 'number' ? vout.value : 0), 0);
  const fee = inputValue > 0 ? inputValue - outputValue : null;
  const isRbf = (tx.vin || []).some((vin) => typeof vin.sequence === 'number' && vin.sequence < 0xfffffffe);

  return {
    txid: tx.txid,
    hash: tx.hash,
    size: tx.size,
    weight: tx.weight,
    locktime: tx.locktime,
    vin: tx.vin,
    vout: tx.vout,
    inputValue,
    outputValue,
    fee,
    isRbf
  };
}

export async function getTipSummary() {
  return getTipData();
}

export async function getBlockViewModel(id, page = 1) {
  const data = await getBlockData(id, page);
  return {
    hash: data.hash,
    height: data.height,
    time: data.timestamp,
    timestamp: data.timestamp ? new Date(data.timestamp * 1000).toISOString() : null,
    size: data.size,
    weight: data.weight,
    version: data.version,
    bits: data.bits,
    difficulty: data.difficulty,
    previousblockhash: data.previousBlockHash,
    nextblockhash: data.nextBlockHash,
    txCount: data.txCount,
    txids: data.txids,
    page: data.pagination.page,
    totalPages: data.pagination.totalPages,
    pageSize: data.pagination.pageSize
  };
}

export async function getTransactionViewModel(txid) {
  const data = await getTransactionData(txid);
  return data;
}

export async function resolveSearchQuery(query) {
  const value = query?.trim();
  if (!value) {
    throw new BadRequestError('Search query is required');
  }

  const bech32Address = /^(bc1|tb1|bcrt1)[0-9a-z]{11,71}$/i;
  const base58Address = /^[123mn][1-9A-HJ-NP-Za-km-z]{25,39}$/;
  const xpubPattern = /^(xpub|ypub|zpub|tpub|vpub|upub|Ypub|Zpub|Vpub|Upub)/;

  if (bech32Address.test(value) || base58Address.test(value)) {
    return { type: 'address', id: value };
  }

  if (xpubPattern.test(value)) {
    return { type: 'xpub', id: value };
  }

  if (DIGITS.test(value)) {
    return { type: 'block', id: value };
  }

  if (HEX_64.test(value)) {
    try {
      const block = await fetchBlock(value);
      if (block) {
        return { type: 'block', id: block.hash };
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) {
        throw error;
      }
    }

    const tx = await getTransactionData(value);
    if (tx) {
      return { type: 'tx', id: value };
    }
  }

  throw new NotFoundError('No matching resource for query');
}
