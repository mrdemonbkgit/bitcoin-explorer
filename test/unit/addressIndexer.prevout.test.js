import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const poolMockState = {
  fetchMany: vi.fn(async (items) => items.map(({ vout }) => ({
    status: 'ok',
    prevout: {
      n: vout,
      value: 1.23,
      scriptPubKey: {
        addresses: ['worker-address']
      }
    }
  })))
};

vi.mock('../../src/infra/prevoutWorkerPool.js', () => {
  class FakePool {
    constructor(size, logger) {
      this.size = size;
      this.logger = logger;
    }
    async init() {}
    async fetchMany(items) {
      return poolMockState.fetchMany(items);
    }
    async destroy() {}
    static isSupported() {
      return true;
    }
  }
  return {
    PrevoutWorkerPool: FakePool,
    isWorkerThreadsAvailable: () => true
  };
});

const rpcMock = vi.fn(async (method, params) => {
  if (method === 'getrawtransaction') {
    const txid = params?.[0];
    return {
      vout: [
        {
          n: 0,
          value: 0.5,
          scriptPubKey: {
            addresses: [`inline-${txid}`]
          }
        }
      ]
    };
  }
  throw new Error(`Unexpected rpc method ${method}`);
});

vi.mock('../../src/rpc.js', () => ({
  rpcCall: rpcMock
}));

const metricsMock = {
  recordAddressIndexerPrevoutDuration: vi.fn(),
  recordAddressIndexerBlockDuration: vi.fn(),
  observeRpcRequest: vi.fn(),
  observeHttpRequest: vi.fn(),
  recordCacheEvent: vi.fn(),
  recordZmqEvent: vi.fn(),
  recordWebsocketConnection: vi.fn(),
  recordWebsocketMessage: vi.fn()
};

vi.mock('../../src/infra/metrics.js', () => ({
  metrics: metricsMock,
  metricsEnabled: true,
  metricsHandler: vi.fn()
}));

describe('AddressIndexer.fetchPrevouts', () => {
  let AddressIndexer;

  beforeEach(async () => {
    vi.restoreAllMocks();
    poolMockState.fetchMany.mockClear();
    rpcMock.mockClear();
    metricsMock.recordAddressIndexerPrevoutDuration.mockClear();
    ({ AddressIndexer } = await import('../../src/infra/addressIndexer.js'));
  });

  afterEach(async () => {
    if (poolMockState.fetchMany.mock.instances) {
      poolMockState.fetchMany.mockClear();
    }
  });

  it('uses the worker pool when enabled and records metrics', async () => {
    const indexer = new AddressIndexer({ logger: null });
    const transaction = {
      vin: [
        { txid: 'worker-tx', vout: 0 }
      ]
    };

    const results = await indexer.fetchPrevouts(transaction);

    expect(results).toHaveLength(1);
    expect(results[0]?.scriptPubKey?.addresses?.[0]).toBe('worker-address');
    expect(poolMockState.fetchMany).toHaveBeenCalledTimes(1);
    expect(metricsMock.recordAddressIndexerPrevoutDuration).toHaveBeenCalledWith(expect.objectContaining({ source: 'rpc' }));
  });

  it('falls back to inline RPC when worker pool fails', async () => {
    poolMockState.fetchMany.mockRejectedValueOnce(new Error('worker failure'));
    const indexer = new AddressIndexer({ logger: null });
    const transaction = {
      vin: [
        { txid: 'fallback-tx', vout: 0 }
      ]
    };

    const results = await indexer.fetchPrevouts(transaction);

    expect(poolMockState.fetchMany).toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith('getrawtransaction', ['fallback-tx', true]);
    expect(results[0]?.scriptPubKey?.addresses?.[0]).toBe('inline-fallback-tx');
    expect(metricsMock.recordAddressIndexerPrevoutDuration).toHaveBeenCalledWith(expect.objectContaining({ source: 'rpc' }));
  });
});
