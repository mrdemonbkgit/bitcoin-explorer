import { randomUUID } from 'node:crypto';
import { createRequestLogger, runWithRequestLogger } from '../infra/logger.js';
import { metrics } from '../infra/metrics.js';

const HR_TIME_DIVISOR_MS = 1e6;

export function requestLogger() {
  return (req, res, next) => {
    const requestId = randomUUID();
    const originalUrl = req.originalUrl || req.url || '';
    const method = (req.method || 'GET').toUpperCase();
    const startTime = process.hrtime.bigint();
    const referer = req.headers?.referer || req.headers?.referrer || null;
    const userAgent = req.headers?.['user-agent'] || null;
    const contentLengthHeader = req.headers?.['content-length'];
    const requestBytes = Number.isFinite(Number(contentLengthHeader)) ? Number(contentLengthHeader) : null;
    const isApiRequest = typeof originalUrl === 'string' && originalUrl.startsWith('/api/');
    let responseBytes = 0;

    const requestContext = {
      requestId,
      route: originalUrl,
      method,
      referer,
      userAgent,
      isApi: isApiRequest,
      requestBytes
    };

    const logger = createRequestLogger({ requestId });

    req.log = logger;
    res.locals.logger = logger;
    res.locals.requestId = requestId;

    const originalWrite = typeof res.write === 'function' ? res.write : null;
    const originalEnd = typeof res.end === 'function' ? res.end : null;

    function trackChunk(chunk, encoding) {
      if (chunk) {
        if (Buffer.isBuffer(chunk)) {
          responseBytes += chunk.length;
        } else if (typeof chunk === 'string') {
          responseBytes += Buffer.byteLength(chunk, encoding);
        }
      }
    }

    res.write = function write(chunk, encoding, callback) {
      trackChunk(chunk, encoding);
      if (originalWrite) {
        return originalWrite.call(this, chunk, encoding, callback);
      }
      return true;
    };

    res.end = function end(chunk, encoding, callback) {
      trackChunk(chunk, encoding);
      if (originalEnd) {
        return originalEnd.call(this, chunk, encoding, callback);
      }
      return true;
    };

    const logStart = () => {
      logger.info({
        context: {
          ...requestContext,
          event: 'request.start'
        }
      }, 'request.start');
    };

    const logFinish = (event = 'request.finish') => {
      const durationMs = Number(process.hrtime.bigint() - startTime) / HR_TIME_DIVISOR_MS;
      const contentLength = res.getHeader('content-length');
      const responseSize = Number.isFinite(Number(contentLength)) ? Number(contentLength) : responseBytes;
      const routeTemplate = req.route?.path || req.baseUrl || requestContext.route;
      metrics.observeHttpRequest({
        req,
        method,
        statusCode: res.statusCode,
        startedAt: startTime
      });
      logger.info({
        context: {
          ...requestContext,
          status: res.statusCode,
          durationMs,
          event,
          routeTemplate,
          responseBytes: responseSize,
          contentLength: contentLength ?? null,
          isApi: isApiRequest
        }
      }, event);
    };

    res.on('finish', () => logFinish('request.finish'));
    res.on('close', () => {
      if (!res.writableEnded) {
        logFinish('request.closed');
      }
    });

    logStart();

    runWithRequestLogger(logger, () => {
      try {
        next();
      } catch (error) {
        logger.error({
          context: {
            ...requestContext,
            event: 'request.error'
          },
          err: error
        }, 'request.error');
        throw error;
      }
    });
  };
}
