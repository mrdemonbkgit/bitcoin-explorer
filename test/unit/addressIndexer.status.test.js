import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const rpcMock = vi.fn();

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
  recordWebsocketMessage: vi.fn(),
  recordAddressIndexerSyncStatus: vi.fn()
};

vi.mock('../../src/infra/metrics.js', () => ({
  metrics: metricsMock,
  metricsEnabled: true,
  metricsHandler: vi.fn()
}));

vi.mock('../../src/infra/prevoutWorkerPool.js', () => ({
  PrevoutWorkerPool: class {
    constructor() {
      this.size = 0;
    }
    async init() {
      return this;
    }
    async fetchMany() {
      return [];
    }
    async destroy() {}
    static isSupported() {
      return false;
    }
  },
  isWorkerThreadsAvailable: () => false
}));

describe('AddressIndexer.getStatus', () => {
  let AddressIndexer;

  beforeEach(async () => {
    vi.resetModules();
    rpcMock.mockReset();
    metricsMock.recordAddressIndexerBlockDuration.mockReset();
    metricsMock.recordAddressIndexerPrevoutDuration.mockReset();
    metricsMock.recordAddressIndexerSyncStatus.mockReset();
    ({ AddressIndexer } = await import('../../src/infra/addressIndexer.js'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('computes progress and throughput using recent block samples', async () => {
    rpcMock.mockImplementation(async (method, params) => {
      if (method === 'getblockcount') {
        return 201;
      }
      if (method === 'getblockhash') {
        return `hash-${params?.[0]}`;
      }
      throw new Error(`unexpected method ${method}`);
    });

    const indexer = new AddressIndexer({ logger: null });

    indexer.recordBlockSample({ height: 100, hash: 'hash-100', txCount: 400, durationMs: 400 });
    vi.advanceTimersByTime(1000);
    indexer.recordBlockSample({ height: 101, hash: 'hash-101', txCount: 200, durationMs: 600 });

    const status = await indexer.getStatus({ refreshTip: true });

    expect(rpcMock).toHaveBeenCalledWith('getblockcount');
    expect(rpcMock).toHaveBeenCalledWith('getblockhash', [201]);
    expect(status.state).toBe('catching_up');
    expect(status.blocksRemaining).toBe(100);
    expect(status.progressPercent).toBeCloseTo(50.5, 1);
    expect(status.throughput.sampleCount).toBe(2);
    expect(status.throughput.blocksPerSecond).toBeCloseTo(2, 5);
    expect(status.throughput.transactionsPerSecond).toBeCloseTo(600, 3);
    expect(status.estimatedCompletionMs).toBe(50000);
    expect(status.chainTip.height).toBe(201);
    expect(status.chainTip.stale).toBe(false);
    expect(metricsMock.recordAddressIndexerSyncStatus).toHaveBeenCalledWith(expect.objectContaining({
      state: 'catching_up',
      blocksRemaining: 100,
      progressPercent: expect.any(Number)
    }));
  });

  it('returns degraded state when chain tip cannot be fetched', async () => {
    rpcMock.mockImplementation(async (method) => {
      if (method === 'getblockcount') {
        throw new Error('rpc unavailable');
      }
      throw new Error(`unexpected method ${method}`);
    });

    const indexer = new AddressIndexer({ logger: null });

    const status = await indexer.getStatus({ refreshTip: true });

    expect(status.state).toBe('degraded');
    expect(status.chainTip.error).toBe('rpc unavailable');
    expect(status.blocksRemaining).toBeNull();
    expect(status.throughput.sampleCount).toBe(0);
    expect(metricsMock.recordAddressIndexerSyncStatus).toHaveBeenCalledWith(expect.objectContaining({
      state: 'degraded'
    }));
  });
});
