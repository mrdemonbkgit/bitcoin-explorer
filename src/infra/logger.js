import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { config } from '../config.js';

const requestLoggerStore = new AsyncLocalStorage();
let loggerInstance;

function createLogger() {
  const options = {
    level: config.logging.level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  };

  if (config.logging.pretty) {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        singleLine: false
      }
    });
    return pino(options, transport);
  }

  return pino(options);
}

export function getLogger() {
  if (!loggerInstance) {
    loggerInstance = createLogger();
  }
  return loggerInstance;
}

export function runWithRequestLogger(logger, callback) {
  return requestLoggerStore.run(logger, callback);
}

export function getRequestLogger() {
  return requestLoggerStore.getStore() ?? getLogger();
}

export function createRequestLogger(bindings = {}) {
  const baseLogger = getLogger();
  return baseLogger.child(bindings);
}
