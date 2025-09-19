import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';

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

describe('API/UI parity', () => {
  beforeEach(() => {
    Object.values(serviceMocks).forEach((mock) => mock.mockReset());
    mempoolMock.getMempoolViewModel.mockReset();
  });

  it('home page and tip API share data source', async () => {
    serviceMocks.getTipData.mockResolvedValue({
      chain: 'main',
      height: 42,
      bestHash: 'hash',
      mempool: { txCount: 1, bytes: 100 },
      feeEstimates: { 1: 1, 3: 2, 6: 3 }
    });

    const app = createApp();

    const [html, api] = await Promise.all([
      request(app).get('/'),
      request(app).get('/api/v1/tip')
    ]);

    expect(html.status).toBe(200);
    expect(api.status).toBe(200);
    expect(api.body.data.height).toBe(42);
    expect(html.text).toContain('42');
  });

  it('block HTML timestamp aligns with API timestamp', async () => {
    serviceMocks.getBlockData.mockResolvedValue({
      hash: 'block-hash',
      height: 10,
      timestamp: 1700000000,
      size: 1000,
      weight: 4000,
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

    const [html, api] = await Promise.all([
      request(app).get('/block/10'),
      request(app).get('/api/v1/block/10')
    ]);

    expect(api.body.data.timestamp).toBe(1700000000);
    expect(html.text).toContain('2023-11-14');
  });

  it('transaction page mirrors API data', async () => {
    serviceMocks.getTransactionData.mockResolvedValue({
      txid: 'tx1',
      hash: 'tx1',
      size: 200,
      weight: 800,
      locktime: 0,
      vin: [],
      vout: [],
      inputValue: 1,
      outputValue: 0.999,
      fee: 0.001,
      isRbf: false
    });

    const app = createApp();

    const [html, api] = await Promise.all([
      request(app).get('/tx/tx1'),
      request(app).get('/api/v1/tx/tx1')
    ]);

    expect(api.body.data.fee).toBeCloseTo(0.001);
    expect(html.text).toContain('0.001');
  });
});
