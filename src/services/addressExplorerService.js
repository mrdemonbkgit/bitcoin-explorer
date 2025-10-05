import * as bitcoin from 'bitcoinjs-lib';
import * as bip32 from 'bip32';
import { config } from '../config.js';
import { NotFoundError, BadRequestError } from '../errors.js';
import { startAddressIndexer, getAddressIndexer } from '../infra/addressIndexer.js';
import { metrics } from '../infra/metrics.js';

function ensureIndexerStarted() {
  if (!config.address.enabled) {
    throw new BadRequestError('Address explorer feature is disabled');
  }
  if (!getAddressIndexer()) {
    return startAddressIndexer();
  }
  return Promise.resolve(getAddressIndexer());
}

function createEmptyStatus() {
  return {
    syncInProgress: false,
    lastProcessed: null,
    chainTip: null,
    blocksRemaining: null,
    progressPercent: null,
    throughput: {
      sampleCount: 0,
      windowMs: 0,
      blocksPerSecond: null,
      transactionsPerSecond: null
    },
    estimatedCompletionMs: null
  };
}

export async function getAddressDetails(address, { page = 1, pageSize = 25 } = {}) {
  if (!address || typeof address !== 'string') {
    throw new BadRequestError('Address is required');
  }
  await ensureIndexerStarted();
  const indexer = getAddressIndexer();
  const summary = await indexer.getAddressSummary(address);
  if (!summary) {
    throw new NotFoundError('Address not found in local index');
  }
  const txs = await indexer.getAddressTransactions(address, { page, pageSize });
  const utxos = await indexer.getAddressUtxos(address);

  return {
    summary,
    utxos,
    transactions: txs.rows,
    pagination: txs.pagination
  };
}

const REGTEST_NETWORK = Object.freeze({
  ...bitcoin.networks.testnet,
  bech32: 'bcrt',
  bip32: { ...bitcoin.networks.testnet.bip32 }
});

const XPUB_NETWORK_CANDIDATES = [
  bitcoin.networks.bitcoin,
  REGTEST_NETWORK,
  bitcoin.networks.testnet
];

function deriveAddressesFromNode(node, network, gapLimit) {
  const result = [];
  const branchNodes = {
    0: node.derive(0),
    1: node.derive(1)
  };
  for (const branch of [0, 1]) {
    const branchNode = branchNodes[branch];
    for (let index = 0; index < gapLimit; index += 1) {
      const child = branchNode.derive(index);
      const payment = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
      if (!payment?.address) {
        continue;
      }
      result.push({ branch, index, address: payment.address });
    }
  }
  return result;
}

async function deriveAddressesFromXpub(xpub, gapLimit, { indexer }) {
  let fallback = null;

  for (const candidate of XPUB_NETWORK_CANDIDATES) {
    let node;
    try {
      node = bip32.fromBase58(xpub, candidate);
    } catch {
      continue;
    }

    const derived = deriveAddressesFromNode(node, candidate, gapLimit);
    if (!fallback) {
      fallback = derived;
    }

    if (!indexer) {
      return derived;
    }

    if (indexer) {
      const summaries = await Promise.all(derived.map((entry) => indexer.getAddressSummary(entry.address)));
      if (summaries.some(Boolean)) {
        return derived;
      }
    }
  }

  if (fallback) {
    return fallback;
  }
  throw new BadRequestError('Invalid xpub');
}

export async function getXpubDetails(xpub) {
  await ensureIndexerStarted();
  const indexer = getAddressIndexer();
  const gapLimit = config.address.xpubGapLimit;
  const derived = await deriveAddressesFromXpub(xpub, gapLimit, { indexer });

  const summaries = await Promise.all(derived.map((entry) => indexer.getAddressSummary(entry.address)));

  const addresses = [];
  let totalBalance = 0;
  let totalReceived = 0;
  let totalSent = 0;

  derived.forEach((item, idx) => {
    const summary = summaries[idx];
    if (!summary) {
      addresses.push({ ...item, balanceSat: 0, totalReceivedSat: 0, totalSentSat: 0, txCount: 0 });
      return;
    }
    addresses.push({
      ...item,
      balanceSat: summary.balanceSat,
      totalReceivedSat: summary.totalReceivedSat,
      totalSentSat: summary.totalSentSat,
      txCount: summary.txCount
    });
    totalBalance += summary.balanceSat;
    totalReceived += summary.totalReceivedSat;
    totalSent += summary.totalSentSat;
  });

  return {
    xpub,
    gapLimit,
    totals: {
      balanceSat: totalBalance,
      totalReceivedSat: totalReceived,
      totalSentSat: totalSent
    },
    addresses
  };
}

export async function primeAddressIndexer() {
  if (!config.address.enabled) {
    return null;
  }
  return ensureIndexerStarted();
}

export async function getIndexerStatus({ refreshTip = false } = {}) {
  if (!config.address.enabled) {
    metrics.recordAddressIndexerSyncStatus({
      state: 'disabled',
      blocksRemaining: null,
      progressPercent: null,
      estimatedCompletionSeconds: null,
      tipHeight: null,
      lastProcessedHeight: null,
      syncInProgress: false
    });
    return {
      featureEnabled: false,
      state: 'disabled',
      ...createEmptyStatus()
    };
  }

  try {
    await ensureIndexerStarted();
  } catch (error) {
    metrics.recordAddressIndexerSyncStatus({
      state: 'error',
      blocksRemaining: null,
      progressPercent: null,
      estimatedCompletionSeconds: null,
      tipHeight: null,
      lastProcessedHeight: null,
      syncInProgress: false
    });
    return {
      featureEnabled: true,
      state: 'error',
      error: error instanceof Error ? error.message : 'Failed to start address indexer',
      ...createEmptyStatus()
    };
  }

  const indexer = getAddressIndexer();
  if (!indexer) {
    metrics.recordAddressIndexerSyncStatus({
      state: 'starting',
      blocksRemaining: null,
      progressPercent: null,
      estimatedCompletionSeconds: null,
      tipHeight: null,
      lastProcessedHeight: null,
      syncInProgress: true
    });
    return {
      featureEnabled: true,
      state: 'starting',
      ...createEmptyStatus()
    };
  }

  try {
    const status = await indexer.getStatus({ refreshTip });
    return {
      featureEnabled: true,
      ...status
    };
  } catch (error) {
    metrics.recordAddressIndexerSyncStatus({
      state: 'error',
      blocksRemaining: null,
      progressPercent: null,
      estimatedCompletionSeconds: null,
      tipHeight: null,
      lastProcessedHeight: null,
      syncInProgress: false
    });
    return {
      featureEnabled: true,
      state: 'error',
      error: error instanceof Error ? error.message : 'Failed to retrieve indexer status',
      ...createEmptyStatus()
    };
  }
}
