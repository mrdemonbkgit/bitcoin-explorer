import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const addressExplorerMocks = vi.hoisted(() => ({
  primeAddressIndexer: vi.fn().mockResolvedValue(null),
  getAddressDetails: vi.fn(),
  getXpubDetails: vi.fn(),
  getIndexerStatus: vi.fn().mockResolvedValue({
    featureEnabled: true,
    state: 'catching_up',
    syncInProgress: true,
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
  })
}));

vi.mock('../../src/services/addressExplorerService.js', () => addressExplorerMocks);

import { createApp } from '../../src/server.js';

beforeEach(() => {
  Object.values(addressExplorerMocks).forEach((mock) => mock.mockReset());
  addressExplorerMocks.primeAddressIndexer.mockResolvedValue(null);
  addressExplorerMocks.getIndexerStatus.mockResolvedValue({
    featureEnabled: true,
    state: 'catching_up',
    syncInProgress: true,
    lastProcessed: { height: 100, hash: 'hash-100', updatedAt: '2025-09-26T00:00:00.000Z' },
    chainTip: { height: 120, hash: 'hash-120', updatedAt: '2025-09-26T00:00:05.000Z', stale: false, error: null, hashError: null },
    blocksRemaining: 20,
    progressPercent: 83.33,
    throughput: {
      sampleCount: 5,
      windowMs: 4000,
      blocksPerSecond: 1.25,
      transactionsPerSecond: 12.5
    },
    estimatedCompletionMs: 16000,
    syncStats: {
      blocksProcessed: 5,
      transactionsProcessed: 100,
      prevoutCacheHits: 2,
      prevoutRpcCalls: 10,
      prevoutWorkers: 4,
      levelCacheBytes: 0,
      levelWriteBufferBytes: 0,
      prevoutCacheMax: 2000,
      prevoutCacheTtl: 60000,
      batchBlockCount: 1,
      parallelPrevoutEnabled: true
    }
  });
});

describe('API address explorer', () => {
  it('returns address summary payload', async () => {
    addressExplorerMocks.getAddressDetails.mockResolvedValue({
      summary: { address: 'bc1qexample' },
      utxos: [],
      transactions: [],
      pagination: { page: 1, pageSize: 25, totalRows: 0 }
    });

    const app = createApp();
    const response = await request(app).get('/api/v1/address/bc1qexample');

    expect(response.status).toBe(200);
    expect(addressExplorerMocks.getAddressDetails).toHaveBeenCalledWith('bc1qexample', { page: 1, pageSize: 25 });
    expect(response.body.data.summary.address).toBe('bc1qexample');
  });

  it('returns xpub summary payload', async () => {
    addressExplorerMocks.getXpubDetails.mockResolvedValue({
      xpub: 'xpub-test',
      addresses: []
    });

    const app = createApp();
    const response = await request(app).get('/api/v1/xpub/xpub-test');

    expect(response.status).toBe(200);
    expect(addressExplorerMocks.getXpubDetails).toHaveBeenCalledWith('xpub-test');
    expect(response.body.data.xpub).toBe('xpub-test');
  });

  it('returns indexer status payload', async () => {
    const app = createApp();
    const response = await request(app).get('/api/v1/indexer/status');

    expect(response.status).toBe(200);
    expect(addressExplorerMocks.getIndexerStatus).toHaveBeenCalled();
    expect(response.body.data.state).toBe('catching_up');
    expect(response.body.meta.generatedAt).toBeDefined();
  });
});
