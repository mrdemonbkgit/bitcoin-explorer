import * as bitcoin from 'bitcoinjs-lib';
import * as bip32 from 'bip32';
import { config } from '../config.js';
import { NotFoundError, BadRequestError } from '../errors.js';
import { startAddressIndexer, getAddressIndexer } from '../infra/addressIndexer.js';

function ensureIndexerStarted() {
  if (!config.address.enabled) {
    throw new BadRequestError('Address explorer feature is disabled');
  }
  if (!getAddressIndexer()) {
    return startAddressIndexer();
  }
  return Promise.resolve(getAddressIndexer());
}

export async function getAddressDetails(address, { page = 1, pageSize = 25 } = {}) {
  if (!address || typeof address !== 'string') {
    throw new BadRequestError('Address is required');
  }
  await ensureIndexerStarted();
  const indexer = getAddressIndexer();
  const summary = indexer.getAddressSummary(address);
  if (!summary) {
    throw new NotFoundError('Address not found in local index');
  }
  const txs = indexer.getAddressTransactions(address, { page, pageSize });
  const utxos = indexer.getAddressUtxos(address);

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

function deriveAddressesFromXpub(xpub, gapLimit, { indexer }) {
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

    const hasMatch = derived.some((entry) => Boolean(indexer.getAddressSummary(entry.address)));
    if (hasMatch) {
      return derived;
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
  const derived = deriveAddressesFromXpub(xpub, gapLimit, { indexer });

  const addresses = [];
  let totalBalance = 0;
  let totalReceived = 0;
  let totalSent = 0;

  for (const item of derived) {
    const summary = indexer.getAddressSummary(item.address);
    if (!summary) {
      addresses.push({ ...item, balanceSat: 0, totalReceivedSat: 0, totalSentSat: 0, txCount: 0 });
      continue;
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
  }

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
