import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip32 from 'bip32';

const startAddressIndexerMock = vi.fn();
const getAddressIndexerMock = vi.fn();
const recordIndexerSyncStatusMock = vi.fn();

vi.mock('../../src/infra/addressIndexer.js', () => ({
  startAddressIndexer: startAddressIndexerMock,
  getAddressIndexer: getAddressIndexerMock
}));

vi.mock('../../src/infra/metrics.js', () => ({
  metrics: {
    recordAddressIndexerSyncStatus: recordIndexerSyncStatusMock
  },
  metricsEnabled: true,
  metricsHandler: vi.fn()
}));

describe('addressExplorerService', () => {
  beforeEach(() => {
    vi.resetModules();
    startAddressIndexerMock.mockReset();
    getAddressIndexerMock.mockReset();
    recordIndexerSyncStatusMock.mockReset();
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

  describe('getIndexerStatus', () => {
    it('returns disabled state when address explorer is off', async () => {
      process.env.FEATURE_ADDRESS_EXPLORER = 'false';
      const { getIndexerStatus } = await import('../../src/services/addressExplorerService.js');

      const status = await getIndexerStatus();

      expect(status.featureEnabled).toBe(false);
      expect(status.state).toBe('disabled');
      expect(status.throughput.sampleCount).toBe(0);
      expect(recordIndexerSyncStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'disabled' }));
    });

    it('returns starting state when indexer has not initialised yet', async () => {
      getAddressIndexerMock.mockReturnValue(null);
      startAddressIndexerMock.mockResolvedValue(null);

      const { getIndexerStatus } = await import('../../src/services/addressExplorerService.js');

      const status = await getIndexerStatus();

      expect(startAddressIndexerMock).toHaveBeenCalled();
      expect(status.featureEnabled).toBe(true);
      expect(status.state).toBe('starting');
      expect(status.blocksRemaining).toBeNull();
      expect(recordIndexerSyncStatusMock).toHaveBeenCalledWith(expect.objectContaining({ state: 'starting' }));
    });

    it('returns status payload from the running indexer', async () => {
      const indexer = {
        getStatus: vi.fn().mockResolvedValue({
          state: 'catching_up',
          syncInProgress: true,
          lastProcessed: { height: 120, hash: 'hash-120', updatedAt: '2025-09-26T00:00:00.000Z' },
          chainTip: { height: 150, hash: 'hash-150', updatedAt: '2025-09-26T00:00:05.000Z', stale: false, error: null, hashError: null },
          blocksRemaining: 30,
          progressPercent: 80,
          throughput: {
            sampleCount: 10,
            windowMs: 5000,
            blocksPerSecond: 2,
            transactionsPerSecond: 12
          },
          estimatedCompletionMs: 15000,
          syncStats: {
            blocksProcessed: 200,
            transactionsProcessed: 1000,
            prevoutCacheHits: 50,
            prevoutRpcCalls: 150,
            prevoutWorkers: 4,
            levelCacheBytes: 0,
            levelWriteBufferBytes: 0,
            prevoutCacheMax: 2000,
            prevoutCacheTtl: 60000,
            batchBlockCount: 1,
            parallelPrevoutEnabled: true
          }
        })
      };

      getAddressIndexerMock.mockReturnValue(indexer);

      const { getIndexerStatus } = await import('../../src/services/addressExplorerService.js');

      const status = await getIndexerStatus({ refreshTip: true });

      expect(indexer.getStatus).toHaveBeenCalledWith({ refreshTip: true });
      expect(status.featureEnabled).toBe(true);
      expect(status.state).toBe('catching_up');
      expect(status.throughput.blocksPerSecond).toBe(2);
      expect(recordIndexerSyncStatusMock).not.toHaveBeenCalled();
    });
  });
});
