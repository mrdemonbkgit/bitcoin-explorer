import request from 'supertest';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const addressExplorerMocks = vi.hoisted(() => ({
  primeAddressIndexer: vi.fn().mockResolvedValue(null),
  getAddressDetails: vi.fn(),
  getXpubDetails: vi.fn()
}));

vi.mock('../../src/services/addressExplorerService.js', () => addressExplorerMocks);

import { createApp } from '../../src/server.js';

beforeEach(() => {
  Object.values(addressExplorerMocks).forEach((mock) => mock.mockReset());
  addressExplorerMocks.primeAddressIndexer.mockResolvedValue(null);
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
});
