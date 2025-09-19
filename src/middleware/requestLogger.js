import { randomUUID } from 'node:crypto';
import { createRequestLogger, runWithRequestLogger } from '../infra/logger.js';
import { metrics } from '../infra/metrics.js';

const HR_TIME_DIVISOR_MS = 1e6;

export function requestLogger() {
  return (req, res, next) => {
    const requestId = randomUUID();
    const route = req.originalUrl || req.url || '';
    const method = (req.method || 'GET').toUpperCase();
    const startTime = process.hrtime.bigint();

    const requestContext = {
      requestId,
      route,
      method
    };

    const logger = createRequestLogger({ requestId });

    req.log = logger;
    res.locals.logger = logger;
    res.locals.requestId = requestId;

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
          event
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
