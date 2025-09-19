import { LRUCache } from 'lru-cache';

export function createCache(ttlMilliseconds) {
  const store = new LRUCache({
    max: 512,
    ttl: ttlMilliseconds,
    allowStale: false
  });

  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value, { ttl: ttlMilliseconds }),
    delete: (key) => store.delete(key),
    clear: () => store.clear(),
    async fetch(key, loader) {
      if (store.has(key)) {
        return store.get(key);
      }
      const value = await loader();
      store.set(key, value, { ttl: ttlMilliseconds });
      return value;
    }
  };
}
