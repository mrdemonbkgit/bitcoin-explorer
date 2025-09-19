import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundError } from '../../src/errors.js';

const rpcCallMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/rpc.js', () => ({
  rpcCall: rpcCallMock
}));

import {
  getBlockViewModel,
  resolveSearchQuery,
  getTipSummary
} from '../../src/services/bitcoinService.js';
import { emit, CacheEvents } from '../../src/infra/cacheEvents.js';

beforeEach(() => {
  rpcCallMock.mockReset();
});

describe('getBlockViewModel', () => {
  it('normalises ids and paginates transactions', async () => {
    const blockHash = 'abc123';
    const blockTx = Array.from({ length: 30 }, (_, index) => ({ txid: `tx-${index}` }));

    rpcCallMock.mockImplementation(async (method, params) => {
      if (method === 'getblockhash') {
        expect(params).toEqual([123]);
        return blockHash;
      }
      if (method === 'getblock') {
        expect(params).toEqual([blockHash, 2]);
        return {
          hash: blockHash,
          height: 123,
          time: 1700000000,
          size: 1000,
          weight: 4000,
          version: 1,
          bits: '1d00ffff',
          difficulty: 1,
          previousblockhash: 'prev',
          nextblockhash: 'next',
          tx: blockTx
        };
      }
      throw new Error(`Unexpected RPC call: ${method}`);
    });

    const result = await getBlockViewModel('123', 3);

    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.txids).toEqual(['tx-25', 'tx-26', 'tx-27', 'tx-28', 'tx-29']);
    expect(result.timestamp).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('resolveSearchQuery', () => {
  it('returns transaction redirect when block is not found', async () => {
    const txid = 'a'.repeat(64);

    rpcCallMock.mockImplementation(async (method) => {
      if (method === 'getblock') {
        throw new NotFoundError('not found');
      }
      if (method === 'getrawtransaction') {
        return {
          txid,
          hash: txid,
          size: 200,
          weight: 800,
          locktime: 0,
          vin: [
            {
              sequence: 0xfffffffd,
              prevout: { value: 1.5 }
            }
          ],
          vout: [
            { value: 0.7 },
            { value: 0.7999 }
          ]
        };
      }
      throw new Error(`Unexpected RPC call: ${method}`);
    });

    const result = await resolveSearchQuery(txid);

    expect(result).toEqual({ type: 'tx', id: txid });
    expect(rpcCallMock).toHaveBeenCalledWith('getrawtransaction', [txid, 2]);
  });
});

describe('getTipSummary', () => {
  it('aggregates blockchain and mempool data and caches the result', async () => {
    rpcCallMock.mockImplementation(async (method, params) => {
      switch (method) {
        case 'getblockchaininfo':
          return { chain: 'main', blocks: 800000, bestblockhash: 'best-hash' };
        case 'getmempoolinfo':
          return { size: 512, bytes: 123456 };
        case 'estimatesmartfee':
          return { feerate: params[0] * 0.0001 };
        default:
          throw new Error(`Unexpected RPC call: ${method}`);
      }
    });

    const summaryFirst = await getTipSummary();
    const summarySecond = await getTipSummary();

    expect(summaryFirst).toMatchObject({
      chain: 'main',
      height: 800000,
      bestHash: 'best-hash',
      mempool: {
        txCount: 512,
        bytes: 123456
      }
    });
    expect(summaryFirst.feeEstimates[1]).toBeCloseTo(0.0001, 10);
    expect(summaryFirst.feeEstimates[3]).toBeCloseTo(0.0003, 10);
    expect(summaryFirst.feeEstimates[6]).toBeCloseTo(0.0006, 10);
    expect(summarySecond).toEqual(summaryFirst);
    expect(rpcCallMock).toHaveBeenCalledTimes(5);
  });
});

describe('cache invalidation events', () => {
  it('clears tip cache after block notifications', async () => {
    let height = 800000;
    let bestblockhash = 'best-hash-old';

    rpcCallMock.mockImplementation(async (method, params) => {
      switch (method) {
        case 'getblockchaininfo':
          return { chain: 'main', blocks: height, bestblockhash };
        case 'getmempoolinfo':
          return { size: 512, bytes: 123456 };
        case 'estimatesmartfee':
          return { feerate: params[0] * 0.0001 };
        default:
          throw new Error(`Unexpected RPC call: ${method}`);
      }
    });

    emit(CacheEvents.BLOCK_NEW, { hash: 'initial-reset' });

    const summaryInitial = await getTipSummary();
    const summaryCached = await getTipSummary();
    expect(summaryInitial.bestHash).toBe('best-hash-old');
    expect(summaryCached).toEqual(summaryInitial);
    expect(rpcCallMock).toHaveBeenCalledTimes(5);

    height = 800001;
    bestblockhash = 'best-hash-new';
    emit(CacheEvents.BLOCK_NEW, { hash: bestblockhash });

    const summaryAfter = await getTipSummary();
    expect(summaryAfter.bestHash).toBe('best-hash-new');
    expect(rpcCallMock).toHaveBeenCalledTimes(10);
  });
});
