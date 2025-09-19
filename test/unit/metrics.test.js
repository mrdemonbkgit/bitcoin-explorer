import { describe, expect, it, vi } from 'vitest';
import { createMetrics } from '../../src/infra/metrics.js';

describe('metrics module', () => {
  it('returns 404 handler when disabled', async () => {
    const instance = createMetrics({ enabled: false, path: '/metrics', includeDefault: false });
    const status = vi.fn().mockReturnThis();
    const send = vi.fn();

    await instance.handler({}, { status, send });

    expect(status).toHaveBeenCalledWith(404);
    expect(send).toHaveBeenCalledWith('Metrics disabled');
  });

  it('records http and rpc metrics when enabled', async () => {
    const instance = createMetrics({ enabled: true, path: '/metrics', includeDefault: false });
    const req = { route: { path: '/api/v1/tip' }, baseUrl: '' };
    const startedAt = process.hrtime.bigint();

    instance.observeHttpRequest({ req, method: 'GET', statusCode: 200, startedAt });
    instance.observeRpcRequest({ method: 'getblockcount', outcome: 'success', durationMs: 42 });

    const httpMetric = instance.registry.getSingleMetric('explorer_http_requests_total');
    const httpValues = (await httpMetric.get()).values;
    expect(httpValues[0].labels.route).toBe('/api/v1/tip');
    expect(httpValues[0].value).toBe(1);

    const rpcMetric = instance.registry.getSingleMetric('explorer_rpc_requests_total');
    const rpcValues = (await rpcMetric.get()).values;
    expect(rpcValues[0].labels.method).toBe('getblockcount');
    expect(rpcValues[0].labels.outcome).toBe('success');
    expect(rpcValues[0].value).toBe(1);

    const setHeader = vi.fn();
    const send = vi.fn();
    await instance.handler({}, { setHeader, send }, (error) => {
      if (error) {
        throw error;
      }
    });

    expect(setHeader).toHaveBeenCalledWith('Content-Type', instance.registry.contentType);
    expect(send).toHaveBeenCalledOnce();
    expect(String(send.mock.calls[0][0])).toContain('explorer_http_requests_total');
  });
});
