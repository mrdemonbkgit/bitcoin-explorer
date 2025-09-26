import { describe, expect, it, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const infoSpy = vi.fn();
const childSpy = vi.fn(() => ({
  info: infoSpy,
  error: vi.fn(),
  warn: vi.fn(),
  bindings: () => ({ requestId: 'mock-request' })
}));

vi.mock('../../src/infra/logger.js', () => ({
  createRequestLogger: () => childSpy(),
  runWithRequestLogger: (_logger, callback) => callback()
}));

import { requestLogger } from '../../src/middleware/requestLogger.js';

describe('requestLogger middleware', () => {
  beforeEach(() => {
    infoSpy.mockReset();
    childSpy.mockClear();
  });

  it('logs start and finish events and attaches logger', () => {
    const middleware = requestLogger();
    const req = { method: 'GET', originalUrl: '/resource', headers: {} };
    /** @type {any} */
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      locals: {},
      getHeader: vi.fn()
    });
    res.write = vi.fn();
    res.end = vi.fn();

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(childSpy).toHaveBeenCalledTimes(1);
    expect(req.log).toBeDefined();
    expect(res.locals.logger).toBeDefined();

    req.route = { path: '/resource' };
    res.emit('finish');

    expect(infoSpy).toHaveBeenCalledTimes(2);
    const [startCall, finishCall] = infoSpy.mock.calls;
    expect(startCall[0].context.event).toBe('request.start');
    expect(finishCall[0].context.event).toBe('request.finish');
    expect(finishCall[0].context.status).toBe(200);
    expect(finishCall[0].context.routeTemplate).toBe('/resource');
    expect(finishCall[0].context.responseBytes).toBe(0);
  });

  it('tracks response size when body written', () => {
    const middleware = requestLogger();
    const req = { method: 'GET', originalUrl: '/api/test', headers: {}, route: { path: '/api/test' } };
    /** @type {any} */
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      locals: {},
      getHeader: vi.fn()
    });
    res.write = vi.fn();
    res.end = vi.fn();

    middleware(req, res, () => {});

    res.write('hello');
    res.end();
    res.emit('finish');

    const finishCall = infoSpy.mock.calls.at(-1);
    expect(finishCall[0].context.isApi).toBe(true);
    expect(finishCall[0].context.responseBytes).toBeGreaterThan(0);
  });
});
