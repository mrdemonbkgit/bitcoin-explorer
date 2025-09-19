import { LRUCache } from 'lru-cache';

function createRecorder(name, metrics) {
  if (!metrics || typeof metrics.recordCacheEvent !== 'function') {
    return () => {};
  }
  return (event) => metrics.recordCacheEvent({ cache: name, event });
}

export function createCache(ttlMilliseconds, options = {}) {
  const { name = 'cache', metrics } = options;
  const record = createRecorder(name, metrics);

  const store = new LRUCache({
    max: 512,
    ttl: ttlMilliseconds,
    allowStale: false
  });

  return {
    get: (key) => store.get(key),
    set: (key, value) => {
      record('set');
      return store.set(key, value, { ttl: ttlMilliseconds });
    },
    delete: (key) => {
      const deleted = store.delete(key);
      if (deleted) {
        record('delete');
      }
      return deleted;
    },
    clear: () => {
      store.clear();
      record('clear');
    },
    async fetch(key, loader) {
      if (store.has(key)) {
        record('hit');
        return store.get(key);
      }
      record('miss');
      const value = await loader();
      store.set(key, value, { ttl: ttlMilliseconds });
      record('set');
      return value;
    }
  };
}
