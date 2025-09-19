import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emit, CacheEvents } from '../../src/infra/cacheEvents.js';

const rpcCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/rpc.js', () => ({
  rpcCall: rpcCallMock
}));

import { getMempoolViewModel } from '../../src/services/mempoolService.js';

const now = new Date('2024-11-05T12:34:56Z');

describe('getMempoolViewModel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    rpcCallMock.mockReset();
    emit(CacheEvents.TX_NEW, { txid: 'reset' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns aggregated mempool data with histogram and pagination', async () => {
    rpcCallMock.mockImplementation(async (method) => {
      if (method === 'getmempoolinfo') {
        return { size: 2, bytes: 4500 };
      }
      if (method === 'getrawmempool') {
        return {
          tx1: {
            fee: 0.0001,
            vsize: 200,
            time: (now.getTime() / 1000) - 30,
            'bip125-replaceable': true
          },
          tx2: {
            fees: { base: 0.0002 },
            vsize: 250,
            time: (now.getTime() / 1000) - 60,
            'bip125-replaceable': false
          }
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const first = await getMempoolViewModel(1);
    const second = await getMempoolViewModel(1);

    expect(first.snapshot.txCount).toBe(2);
    expect(first.snapshot.medianFee).toBeCloseTo(65);
    expect(first.snapshot.recent[0].txid).toBe('tx1');
    expect(first.snapshot.recent[0].ageSeconds).toBe(30);
    expect(first.snapshot.recent[0].isRbf).toBe(true);
    expect(first.snapshot.histogram).toHaveLength(6);
    expect(first.snapshot.histogram.at(-1).count).toBe(2);
    expect(second).toEqual(first);
    expect(rpcCallMock).toHaveBeenCalledTimes(2);

    emit(CacheEvents.TX_NEW, { txid: 'new-tx' });
    rpcCallMock.mockClear();

    await getMempoolViewModel(1);
    expect(rpcCallMock).toHaveBeenCalledTimes(2);
  });

  it('paginates recent transactions', async () => {
    const entries = {};
    for (let i = 0; i < 40; i += 1) {
      entries[`tx${i}`] = {
        fee: 0.00001,
        vsize: 150,
        time: (now.getTime() / 1000) - i
      };
    }

    rpcCallMock.mockImplementation(async (method) => {
      if (method === 'getmempoolinfo') {
        return { size: 40, bytes: 6000 };
      }
      if (method === 'getrawmempool') {
        return entries;
      }
      throw new Error(`Unexpected method ${method}`);
    });

    const firstPage = await getMempoolViewModel(1);
    const secondPage = await getMempoolViewModel(2);

    expect(firstPage.pagination.totalPages).toBe(2);
    expect(firstPage.snapshot.recent).toHaveLength(25);
    expect(secondPage.snapshot.recent).toHaveLength(15);
    expect(firstPage.snapshot.recent[0].txid).toBe('tx0');
    expect(secondPage.snapshot.recent.at(-1).txid).toBe('tx39');
  });
});
