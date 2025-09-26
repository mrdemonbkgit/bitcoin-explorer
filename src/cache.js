import { LRUCache } from 'lru-cache';
import { getRequestLogger } from './infra/logger.js';

function createRecorder(name, metrics) {
  if (!metrics || typeof metrics.recordCacheEvent !== 'function') {
    return () => {};
  }
  return (event) => metrics.recordCacheEvent({ cache: name, event });
}

export function createCache(ttlMilliseconds, options = {}) {
  const { name = 'cache', metrics } = options;
  const record = createRecorder(name, metrics);

  function log(event, key) {
    const logger = getRequestLogger();
    if (!logger || typeof logger.bindings !== 'function') {
      return;
    }
    const bindings = logger.bindings();
    if (!bindings || !bindings.requestId) {
      return;
    }
    logger.debug({
      context: {
        event: 'cache.event',
        cache: name,
        cacheEvent: event,
        cacheKey: key
      }
    }, 'cache.event');
  }

  const store = new LRUCache({
    max: 512,
    ttl: ttlMilliseconds,
    allowStale: false
  });

  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      record('set');
      log('set', key);
      return store.set(key, value, { ttl: ttlMilliseconds });
    },
    delete: (key) => {
      const deleted = store.delete(key);
      if (deleted) {
        record('delete');
        log('delete', key);
      }
      return deleted;
    },
    clear: () => {
      store.clear();
      record('clear');
      log('clear');
    },
    async fetch(key, loader) {
      if (store.has(key)) {
        record('hit');
        log('hit', key);
        return store.get(key);
      }
      record('miss');
      log('miss', key);
      const value = await loader();
      store.set(key, value, { ttl: ttlMilliseconds });
      record('set');
      log('populate', key);
      return value;
    }
  };
}
