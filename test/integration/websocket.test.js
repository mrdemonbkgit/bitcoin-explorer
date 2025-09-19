import { describe, expect, it, afterEach, vi } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';

const originalEnv = {
  WEBSOCKET_ENABLED: process.env.WEBSOCKET_ENABLED,
  WEBSOCKET_PATH: process.env.WEBSOCKET_PATH,
  WEBSOCKET_PORT: process.env.WEBSOCKET_PORT
};

afterEach(() => {
  process.env.WEBSOCKET_ENABLED = originalEnv.WEBSOCKET_ENABLED ?? 'false';
  process.env.WEBSOCKET_PATH = originalEnv.WEBSOCKET_PATH ?? '/ws';
  process.env.WEBSOCKET_PORT = originalEnv.WEBSOCKET_PORT ?? '';
  vi.resetModules();
});

describe('WebSocket gateway', () => {
  it('broadcasts cache events to connected clients when enabled', async () => {
    process.env.WEBSOCKET_ENABLED = 'true';
    process.env.WEBSOCKET_PATH = '/ws-test';
    process.env.WEBSOCKET_PORT = '';

    vi.resetModules();

    const [{ createApp }, { startWebsocketGateway }, { CacheEvents, emit }] = await Promise.all([
      import('../../src/server.js'),
      import('../../src/infra/websocketGateway.js'),
      import('../../src/infra/cacheEvents.js')
    ]);

    const app = createApp();
    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const stopGateway = await startWebsocketGateway({ httpServer: server });

    const address = server.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Unable to determine server address');
    }

    const url = `ws://127.0.0.1:${address.port}${process.env.WEBSOCKET_PATH}`;

    /** @type {import('ws') | null} */
    let ws = null;
    try {
      const message = await new Promise((resolve, reject) => {
        ws = new WebSocket(url);
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('Timed out waiting for WebSocket message'));
        }, 5000);

        ws.on('open', () => {
          emit(CacheEvents.BLOCK_NEW, { hash: 'test-hash' });
        });

        ws.on('message', (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(data.toString()));
        });

        ws.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(message.type).toBe('block.new');
      expect(message.hash).toBe('test-hash');
    } finally {
      if (ws) {
        ws.close();
      }
      await stopGateway();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
