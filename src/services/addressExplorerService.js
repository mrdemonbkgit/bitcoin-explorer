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

function deriveAddressesFromXpub(xpub, gapLimit) {
  let node;
  try {
    node = bip32.fromBase58(xpub, bitcoin.networks.bitcoin);
  } catch {
    throw new BadRequestError('Invalid xpub');
  }

  const result = [];
  const branchNodes = {
    0: node.derive(0),
    1: node.derive(1)
  };
  for (const branch of [0, 1]) {
    const branchNode = branchNodes[branch];
    for (let index = 0; index < gapLimit; index += 1) {
      const child = branchNode.derive(index);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: bitcoin.networks.bitcoin });
      if (!address) {
        continue;
      }
      result.push({ branch, index, address });
    }
  }
  return result;
}

export async function getXpubDetails(xpub) {
  await ensureIndexerStarted();
  const indexer = getAddressIndexer();
  const gapLimit = config.address.xpubGapLimit;
  const derived = deriveAddressesFromXpub(xpub, gapLimit);

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
