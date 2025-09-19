import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundError } from '../../src/errors.js';

const serviceMocks = vi.hoisted(() => ({
  getTipData: vi.fn(),
  getBlockData: vi.fn(),
  getTransactionData: vi.fn(),
  resolveSearchQuery: vi.fn()
}));

const mempoolMock = vi.hoisted(() => ({
  getMempoolViewModel: vi.fn()
}));

const addressExplorerMocks = vi.hoisted(() => ({
  primeAddressIndexer: vi.fn().mockResolvedValue(null),
  getAddressDetails: vi.fn(),
  getXpubDetails: vi.fn()
}));

vi.mock('../../src/services/bitcoinService.js', () => serviceMocks);
vi.mock('../../src/services/mempoolService.js', () => mempoolMock);
vi.mock('../../src/services/addressExplorerService.js', () => addressExplorerMocks);

import { createApp } from '../../src/server.js';

beforeEach(() => {
  Object.values(serviceMocks).forEach((mock) => mock.mockReset());
  mempoolMock.getMempoolViewModel.mockReset();
  Object.values(addressExplorerMocks).forEach((mock) => mock.mockReset?.());
  addressExplorerMocks.primeAddressIndexer.mockResolvedValue(null);
});

describe('server routes', () => {
  it('renders the home page using summary data', async () => {
    serviceMocks.getTipData.mockResolvedValue({
      chain: 'main',
      height: 123,
      bestHash: 'hash',
      mempool: { txCount: 42, bytes: 2048 },
      feeEstimates: { 1: 1, 3: null, 6: 6 }
    });

    const app = createApp();
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('<span id="tip-chain">MAIN</span>');
    expect(serviceMocks.getTipData).toHaveBeenCalledTimes(1);
  });

  it('renders block details and passes pagination query', async () => {
    serviceMocks.getBlockData.mockResolvedValue({
      hash: 'block-hash',
      height: 50,
      timestamp: 1700000000,
      size: 1000,
      weight: 4000,
      version: 1,
      bits: '1d00ffff',
      difficulty: 1,
      previousBlockHash: null,
      nextBlockHash: null,
      txCount: 1,
      txids: ['tx-1'],
      pagination: {
        page: 1,
        totalPages: 1,
        pageSize: 25
      }
    });

    const app = createApp();
    const response = await request(app).get('/block/50?page=1');

    expect(response.status).toBe(200);
    expect(serviceMocks.getBlockData).toHaveBeenCalledWith('50', 1);
    expect(response.text).toContain('<code>block-hash</code>');
    expect(response.text).toContain('Transactions (page 1 of 1)');
  });

  it('renders transaction details', async () => {
    serviceMocks.getTransactionData.mockResolvedValue({
      txid: 'tx-1',
      hash: 'tx-1',
      size: 250,
      weight: 1000,
      locktime: 0,
      vin: [
        { txid: 'prev', vout: 0, value: 1.2, sequence: 0xfffffffd, addresses: ['input-addr'] }
      ],
      vout: [
        { n: 0, value: 0.8, addresses: ['addr1'], scriptPubKey: { addresses: ['addr1'], type: 'witness_v0_keyhash' } },
        { n: 1, value: 0.3999, addresses: [], scriptPubKey: { type: 'nulldata' } }
      ],
      inputValue: 1.2,
      outputValue: 1.1999,
      fee: 0.0001,
      isRbf: true
    });

    const app = createApp();
    const response = await request(app).get('/tx/tx-1');

    expect(response.status).toBe(200);
    expect(serviceMocks.getTransactionData).toHaveBeenCalledWith('tx-1');
    expect(response.text).toContain('<strong>TxID:</strong> <code>tx-1</code>');
    expect(response.text).toContain('<span class="tag">Fee</span> 0.0001');
    expect(response.text).toContain('Address');
    expect(response.text).toContain('input-addr');
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
    serviceMocks.getBlockData.mockRejectedValue(new NotFoundError('missing block'));

    const app = createApp();
    const response = await request(app).get('/block/999');

    expect(response.status).toBe(404);
    expect(response.text).toContain('missing block');
  });

  it('renders the mempool dashboard when enabled', async () => {
    mempoolMock.getMempoolViewModel.mockResolvedValue({
      snapshot: {
        updatedAt: '2024-11-05T12:34:56.000Z',
        txCount: 10,
        virtualSize: 5000,
        medianFee: 25,
        histogram: [
          { range: '0-1', count: 1, vsize: 200 },
          { range: '1-5', count: 2, vsize: 400 }
        ],
        recent: [
          { txid: 'tx123', feerate: 12.5, vsize: 200, ageSeconds: 30, isRbf: false }
        ]
      },
      pagination: {
        page: 1,
        pageSize: 25,
        totalPages: 1
      }
    });

    const app = createApp();
    const response = await request(app).get('/mempool');

    expect(response.status).toBe(200);
    expect(response.text).toContain('Mempool Overview');
    expect(response.text).toContain('tx123');
    expect(mempoolMock.getMempoolViewModel).toHaveBeenCalledWith(1);
  });

  it('renders an address page when explorer is enabled', async () => {
    addressExplorerMocks.getAddressDetails.mockResolvedValue({
      summary: {
        address: 'bc1qexample',
        firstSeenHeight: 100,
        lastSeenHeight: 120,
        balanceSat: 5000,
        totalReceivedSat: 10000,
        totalSentSat: 5000,
        txCount: 2,
        utxoCount: 1,
        utxoValueSat: 5000
      },
      utxos: [
        { txid: 'tx123', vout: 0, value_sat: 5000, height: 120 }
      ],
      transactions: [
        { txid: 'tx123', direction: 'in', value_sat: 5000, height: 120, io_index: 0, timestamp: 1700000000 }
      ],
      pagination: { page: 1, pageSize: 25, totalRows: 1 }
    });

    const app = createApp();
    const response = await request(app).get('/address/bc1qexample');

    expect(response.status).toBe(200);
    expect(addressExplorerMocks.getAddressDetails).toHaveBeenCalledWith('bc1qexample', { page: 1, pageSize: 25 });
    expect(response.text).toContain('Address Summary');
    expect(response.text).toContain('bc1qexample');
  });

  it('renders an xpub page with derived addresses', async () => {
    addressExplorerMocks.getXpubDetails.mockResolvedValue({
      xpub: 'xpub-test',
      gapLimit: 5,
      totals: {
        balanceSat: 100,
        totalReceivedSat: 200,
        totalSentSat: 100
      },
      addresses: [
        { branch: 0, index: 0, address: 'bc1qaddr0', balanceSat: 50, totalReceivedSat: 100, totalSentSat: 50, txCount: 1 },
        { branch: 1, index: 0, address: 'bc1qchange0', balanceSat: 50, totalReceivedSat: 100, totalSentSat: 50, txCount: 1 }
      ]
    });

    const app = createApp();
    const response = await request(app).get('/xpub/xpub-test');

    expect(response.status).toBe(200);
    expect(addressExplorerMocks.getXpubDetails).toHaveBeenCalledWith('xpub-test');
    expect(response.text).toContain('xpub-test');
    expect(response.text).toContain('bc1qaddr0');
  });
});
