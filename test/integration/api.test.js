import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AppError } from '../../src/errors.js';

const serviceMocks = vi.hoisted(() => ({
  getTipData: vi.fn(),
  getBlockData: vi.fn(),
  getTransactionData: vi.fn(),
  resolveSearchQuery: vi.fn()
}));

const mempoolMock = vi.hoisted(() => ({
  getMempoolViewModel: vi.fn()
}));

vi.mock('../../src/services/bitcoinService.js', () => serviceMocks);
vi.mock('../../src/services/mempoolService.js', () => mempoolMock);

import { createApp } from '../../src/server.js';

describe('API routes', () => {
  beforeEach(() => {
    Object.values(serviceMocks).forEach((mock) => mock.mockReset());
    mempoolMock.getMempoolViewModel.mockReset();
  });

  it('returns tip data as JSON', async () => {
    serviceMocks.getTipData.mockResolvedValue({
      chain: 'main',
      height: 1,
      bestHash: 'hash',
      mempool: { txCount: 1, bytes: 2 },
      feeEstimates: { 1: 1, 3: 2, 6: 3 }
    });

    const app = createApp();
    const response = await request(app).get('/api/v1/tip');

    expect(response.status).toBe(200);
    expect(response.body.data.chain).toBe('main');
    expect(serviceMocks.getTipData).toHaveBeenCalledTimes(1);
  });

  it('returns block data with pagination', async () => {
    serviceMocks.getBlockData.mockResolvedValue({
      hash: 'block',
      height: 10,
      timestamp: 1700000000,
      size: 100,
      weight: 400,
      version: 1,
      bits: '1d00ffff',
      difficulty: 1,
      previousBlockHash: null,
      nextBlockHash: null,
      txCount: 2,
      txids: ['tx1', 'tx2'],
      pagination: { page: 1, totalPages: 1, pageSize: 25 }
    });

    const app = createApp();
    const response = await request(app).get('/api/v1/block/10?page=1');

    expect(response.status).toBe(200);
    expect(response.body.data.hash).toBe('block');
    expect(response.body.data.pagination.page).toBe(1);
    expect(serviceMocks.getBlockData).toHaveBeenCalledWith('10', 1);
  });

  it('returns transaction data', async () => {
    serviceMocks.getTransactionData.mockResolvedValue({
      txid: 'tx',
      hash: 'tx',
      size: 200,
      weight: 800,
      locktime: 0,
      vin: [],
      vout: [],
      inputValue: 0,
      outputValue: 0,
      fee: null,
      isRbf: false
    });

    const app = createApp();
    const response = await request(app).get('/api/v1/tx/tx');

    expect(response.status).toBe(200);
    expect(response.body.data.txid).toBe('tx');
  });

  it('returns mempool snapshot', async () => {
    mempoolMock.getMempoolViewModel.mockResolvedValue({
      snapshot: {
        updatedAt: '2024-11-05T12:34:56.000Z',
        txCount: 1,
        virtualSize: 500,
        medianFee: 10,
        histogram: [],
        recent: []
      },
      pagination: { page: 1, pageSize: 25, totalPages: 1 }
    });

    const app = createApp();
    const response = await request(app).get('/api/v1/mempool');

    expect(response.status).toBe(200);
    expect(response.body.meta.pagination.page).toBe(1);
  });

  it('maps errors to JSON responses', async () => {
    class TestError extends AppError {
      constructor() {
        super('bad', 418);
      }
    }
    serviceMocks.getTipData.mockRejectedValue(new TestError());

    const app = createApp();
    const response = await request(app).get('/api/v1/tip');

    expect(response.status).toBe(418);
    expect(response.body.error.type).toBe('TestError');
    expect(response.body.error.message).toBe('bad');
  });
});
