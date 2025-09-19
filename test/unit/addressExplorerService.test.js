import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip32 from 'bip32';

const startAddressIndexerMock = vi.fn();
const getAddressIndexerMock = vi.fn();

vi.mock('../../src/infra/addressIndexer.js', () => ({
  startAddressIndexer: startAddressIndexerMock,
  getAddressIndexer: getAddressIndexerMock
}));

describe('addressExplorerService', () => {
  beforeEach(() => {
    vi.resetModules();
    startAddressIndexerMock.mockReset();
    getAddressIndexerMock.mockReset();
    process.env.FEATURE_ADDRESS_EXPLORER = 'true';
  });

  it('derives regtest addresses for testnet xpubs using index data', async () => {
    const seed = Buffer.alloc(64, 1);
    const root = bip32.fromSeed(seed, bitcoin.networks.testnet);
    const account = root.derivePath("m/84'/1'/0'");
    const xpub = account.neutered().toBase58();

    const regtestNetwork = {
      ...bitcoin.networks.testnet,
      bech32: 'bcrt',
      bip32: { ...bitcoin.networks.testnet.bip32 }
    };

    const branchNode = account.derive(0);
    const child = branchNode.derive(0);
    const { address: expectedAddress } = bitcoin.payments.p2wpkh({
      pubkey: child.publicKey,
      network: regtestNetwork
    });

    const indexer = {
      getAddressSummary: vi.fn((requested) => {
        if (requested === expectedAddress) {
          return {
            address: expectedAddress,
            firstSeenHeight: 100,
            lastSeenHeight: 101,
            totalReceivedSat: 1_000_000,
            totalSentSat: 0,
            balanceSat: 1_000_000,
            txCount: 1,
            utxoCount: 1,
            utxoValueSat: 1_000_000
          };
        }
        return null;
      })
    };

    getAddressIndexerMock.mockReturnValue(indexer);

    const { getXpubDetails } = await import('../../src/services/addressExplorerService.js');

    const details = await getXpubDetails(xpub);

    expect(details.addresses.some((entry) => entry.address === expectedAddress)).toBe(true);
    const match = details.addresses.find((entry) => entry.address === expectedAddress);
    expect(match?.balanceSat).toBe(1_000_000);
    expect(details.totals.balanceSat).toBe(1_000_000);
  });
});
