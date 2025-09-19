import { EventEmitter } from 'node:events';

export const CacheEvents = {
  BLOCK_NEW: 'block:new',
  TX_NEW: 'tx:new'
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function subscribe(event, handler) {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}

export function emit(event, payload) {
  emitter.emit(event, payload);
}
