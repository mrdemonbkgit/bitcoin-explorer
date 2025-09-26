import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import { config } from '../config.js';

const requestLoggerStore = new AsyncLocalStorage();
let loggerInstance;

function createLogger() {
  const destination = config.logging.destination;
  const redactPaths = Array.isArray(config.logging.redactPaths) ? config.logging.redactPaths : [];
  const sampleRate = typeof config.logging.sampleRate === 'number' ? config.logging.sampleRate : 1;

  const sampleEligibleLevels = new Set(['trace', 'debug']);

  const options = {
    level: config.logging.level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime
  };

  if (redactPaths.length > 0) {
    options.redact = {
      paths: redactPaths,
      censor: '[Redacted]'
    };
  }

  if (sampleRate >= 0 && sampleRate < 1) {
    options.hooks = {
      logMethod(args, method, level) {
        const levelLabel = this.levels?.labels?.[level] ?? level;
        if (sampleEligibleLevels.has(levelLabel) && Math.random() > sampleRate) {
          return;
        }
        method.apply(this, args);
      }
    };
  }

  let transport = null;
  const prettyRequested = config.logging.pretty;

  try {
    if (destination.type === 'stdout') {
      if (prettyRequested) {
        transport = pino.transport({
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            singleLine: false
          }
        });
      }
    } else if (destination.type === 'file') {
      transport = pino.transport({
        target: 'pino/file',
        options: {
          destination: destination.path,
          mkdir: true,
          append: true
        }
      });
      if (prettyRequested) {
        console.warn('[logger] LOG_PRETTY=true ignored when using file destination');
      }
    } else if (destination.type === 'transport') {
      transport = pino.transport({
        target: destination.target
      });
      if (prettyRequested) {
        console.warn('[logger] LOG_PRETTY=true ignored when using custom transport');
      }
    }
  } catch (error) {
    console.error(`[logger] Failed to configure log transport (${error?.message ?? error}); falling back to stdout`);
    transport = null;
  }

  return transport ? pino(options, transport) : pino(options);
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
