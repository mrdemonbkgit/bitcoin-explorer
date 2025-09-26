import { beforeEach, describe, expect, it, vi } from 'vitest';

const debugSpy = vi.fn();
const bindingsSpy = vi.fn(() => ({ requestId: 'req-123' }));

describe('createCache logging integration', () => {
  let createCache;

  beforeEach(async () => {
    debugSpy.mockReset();
    bindingsSpy.mockReset();
    bindingsSpy.mockReturnValue({ requestId: 'req-123' });

    vi.resetModules();
    vi.doMock('../../src/infra/logger.js', () => ({
      getRequestLogger: () => ({
        debug: debugSpy,
        bindings: bindingsSpy
      })
    }));

    ({ createCache } = await import('../../src/cache.js'));
  });

  it('emits cache logs with request context', async () => {
    const cache = createCache(50, { name: 'test-cache' });
    await cache.fetch('alpha', async () => 'value'); // miss/populate
    await cache.fetch('alpha', async () => 'value'); // hit

    const events = debugSpy.mock.calls.map(([payload]) => payload?.context?.cacheEvent);
    expect(events).toContain('miss');
    expect(events).toContain('populate');
    expect(events).toContain('hit');
    debugSpy.mock.calls.forEach(([payload]) => {
      expect(payload.context.cache).toBe('test-cache');
      expect(payload.context.event).toBe('cache.event');
    });
  });

  it('skips logging when no request bindings exist', async () => {
    bindingsSpy.mockReturnValue(/** @type {any} */ ({}));
    const cache = createCache(50, { name: 'test-cache' });
    await cache.fetch('alpha', async () => 'value');

    expect(debugSpy).not.toHaveBeenCalled();
  });
});
