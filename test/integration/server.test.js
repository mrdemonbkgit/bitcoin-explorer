import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundError } from '../../src/errors.js';

const serviceMocks = vi.hoisted(() => ({
  getTipSummary: vi.fn(),
  getBlockViewModel: vi.fn(),
  getTransactionViewModel: vi.fn(),
  resolveSearchQuery: vi.fn()
}));

vi.mock('../../src/services/bitcoinService.js', () => serviceMocks);

import { createApp } from '../../src/server.js';

beforeEach(() => {
  Object.values(serviceMocks).forEach((mock) => mock.mockReset());
});

describe('server routes', () => {
  it('renders the home page using summary data', async () => {
    serviceMocks.getTipSummary.mockResolvedValue({
      chain: 'main',
      height: 123,
      bestHash: 'hash',
      mempool: { txCount: 42, bytes: 2048 },
      feeEstimates: { 1: 1, 3: null, 6: 6 }
    });

    const app = createApp();
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('<strong>Chain:</strong> MAIN');
    expect(serviceMocks.getTipSummary).toHaveBeenCalledTimes(1);
  });

  it('renders block details and passes pagination query', async () => {
    serviceMocks.getBlockViewModel.mockResolvedValue({
      hash: 'block-hash',
      height: 50,
      time: 1700000000,
      timestamp: '2023-11-14T22:13:20.000Z',
      size: 1000,
      weight: 4000,
      version: 1,
      bits: '1d00ffff',
      difficulty: 1,
      previousblockhash: null,
      nextblockhash: null,
      txCount: 1,
      txids: ['tx-1'],
      page: 1,
      totalPages: 1,
      pageSize: 25
    });

    const app = createApp();
    const response = await request(app).get('/block/50?page=1');

    expect(response.status).toBe(200);
    expect(serviceMocks.getBlockViewModel).toHaveBeenCalledWith('50', 1);
    expect(response.text).toContain('<code>block-hash</code>');
    expect(response.text).toContain('Transactions (page 1 of 1)');
  });

  it('renders transaction details', async () => {
    serviceMocks.getTransactionViewModel.mockResolvedValue({
      txid: 'tx-1',
      hash: 'tx-1',
      size: 250,
      weight: 1000,
      locktime: 0,
      vin: [
        { txid: 'prev', vout: 0, value: 1.2, sequence: 0xfffffffd }
      ],
      vout: [
        { n: 0, value: 0.8, scriptPubKey: { addresses: ['addr1'] } },
        { n: 1, value: 0.3999, scriptPubKey: { type: 'nulldata' } }
      ],
      inputValue: 1.2,
      outputValue: 1.1999,
      fee: 0.0001,
      isRbf: true
    });

    const app = createApp();
    const response = await request(app).get('/tx/tx-1');

    expect(response.status).toBe(200);
    expect(serviceMocks.getTransactionViewModel).toHaveBeenCalledWith('tx-1');
    expect(response.text).toContain('<strong>TxID:</strong> <code>tx-1</code>');
    expect(response.text).toContain('<span class="tag">Fee</span> 0.0001');
  });

  it('redirects search results to the resolved resource', async () => {
    serviceMocks.resolveSearchQuery.mockResolvedValue({ type: 'block', id: '123' });

    const app = createApp();
    const response = await request(app).get('/search?q=123');

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/block/123');
  });

  it('renders a not found page for unknown routes', async () => {
    const app = createApp();
    const response = await request(app).get('/missing');

    expect(response.status).toBe(404);
    expect(response.text).toContain('Page not found');
  });

  it('renders service errors from handlers', async () => {
    serviceMocks.getBlockViewModel.mockRejectedValue(new NotFoundError('missing block'));

    const app = createApp();
    const response = await request(app).get('/block/999');

    expect(response.status).toBe(404);
    expect(response.text).toContain('missing block');
  });
});
