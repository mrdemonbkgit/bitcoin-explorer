import { createServer } from 'node:http';
import { setInterval, clearInterval } from 'node:timers';
import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { getLogger } from './logger.js';
import { metrics } from './metrics.js';
import { CacheEvents, subscribe } from './cacheEvents.js';

const HEARTBEAT_INTERVAL_MS = 30000;

function serialize(message) {
  try {
    return JSON.stringify({ ...message, timestamp: Date.now() });
  } catch {
    return null;
  }
}

/**
 * @param {{ httpServer?: import('node:http').Server }} [options]
 * @returns {Promise<() => Promise<void>>}
 */
export async function startWebsocketGateway({ httpServer } = {}) {
  if (!config.websocket.enabled) {
    return async () => {};
  }

  const logger = getLogger().child({ module: 'websocket' });
  const clients = new Set();
  const { path, port } = config.websocket;

  let attachedServer = httpServer;
  let ownedServer = null;

  if (port && (!attachedServer || port !== config.app.port)) {
    ownedServer = createServer((req, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain');
      res.end('WebSocket endpoint only');
    });

    await new Promise((resolve, reject) => {
      ownedServer.once('error', reject);
      ownedServer.listen(port, config.app.bind, resolve);
    });

    logger.info({
      context: {
        event: 'websocket.listen',
        bind: config.app.bind,
        port
      }
    }, `WebSocket gateway listening on ${config.app.bind}:${port}${path}`);

    attachedServer = ownedServer;
  }

  if (!attachedServer) {
    throw new Error('WebSocket gateway requires an HTTP server or port');
  }

  const wss = new WebSocketServer({ server: attachedServer, path });

  function broadcast(message) {
    const serialized = serialize(message);
    if (!serialized) {
      logger.warn({ context: { event: 'websocket.serialize.error' } }, 'Failed to serialize WebSocket payload');
      return;
    }

    let sent = 0;
    let failed = 0;
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(serialized);
          metrics.recordWebsocketMessage({ type: message.type, event: 'sent' });
          sent += 1;
        } catch (error) {
          metrics.recordWebsocketMessage({ type: message.type, event: 'error' });
          logger.warn({ context: { event: 'websocket.send.error' }, err: error }, 'Failed to send WebSocket message');
          failed += 1;
        }
      }
    }

    logger.debug({
      context: {
        event: 'websocket.broadcast',
        type: message.type,
        recipients: sent,
        failed,
        connectedClients: clients.size
      }
    }, 'Broadcasted WebSocket message');
  }

  wss.on('connection', (socket, request) => {
    clients.add(socket);
    metrics.recordWebsocketConnection({ event: 'open' });
    logger.debug({
      context: {
        event: 'websocket.connection',
        remoteAddress: request.socket.remoteAddress,
        totalClients: clients.size
      }
    }, 'WebSocket client connected');

    socket.on('close', () => {
      clients.delete(socket);
      metrics.recordWebsocketConnection({ event: 'close' });
      logger.debug({
        context: {
          event: 'websocket.connection.closed',
          totalClients: clients.size
        }
      }, 'WebSocket client disconnected');
    });

    socket.on('error', (error) => {
      metrics.recordWebsocketConnection({ event: 'error' });
      logger.warn({ context: { event: 'websocket.client.error' }, err: error }, 'WebSocket client error');
    });

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.isAlive = true;
  });

  wss.on('error', (error) => {
    metrics.recordWebsocketConnection({ event: 'server_error' });
    logger.error({ context: { event: 'websocket.server.error' }, err: error }, 'WebSocket server error');
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.readyState !== client.OPEN) {
        clients.delete(client);
        continue;
      }
      if (client.isAlive === false) {
        client.terminate();
        clients.delete(client);
        metrics.recordWebsocketConnection({ event: 'terminated' });
        logger.debug({
          context: {
            event: 'websocket.connection.terminated',
            totalClients: clients.size
          }
        }, 'WebSocket client terminated after missed heartbeat');
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch (error) {
        metrics.recordWebsocketConnection({ event: 'ping_error' });
        logger.warn({ context: { event: 'websocket.ping.error' }, err: error }, 'WebSocket ping error');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const unsubscribeBlock = subscribe(CacheEvents.BLOCK_NEW, ({ hash }) => {
    broadcast({ type: 'block.new', hash });
    broadcast({ type: 'tip.update' });
    broadcast({ type: 'mempool.invalidate' });
  });

  const unsubscribeTx = subscribe(CacheEvents.TX_NEW, ({ txid }) => {
    broadcast({ type: 'tx.new', txid });
    broadcast({ type: 'mempool.invalidate' });
  });

  return async () => {
    clearInterval(heartbeat);
    unsubscribeBlock();
    unsubscribeTx();

    await new Promise((resolve) => {
      wss.close(() => resolve());
      for (const client of clients) {
        try {
          client.terminate();
        } catch {
          // ignore termination errors
        }
      }
    });

    if (ownedServer) {
      await new Promise((resolve) => ownedServer.close(resolve));
    }
  };
}
