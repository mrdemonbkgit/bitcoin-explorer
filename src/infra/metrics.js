import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from '../config.js';

const HR_TO_SECONDS = 1e9;
const MS_TO_SECONDS = 1000;
const NOOP = () => {};

function createDisabledMetrics(path) {
  return {
    enabled: false,
    path,
    async handler(_req, res) {
      res.status(404).send('Metrics disabled');
    },
    observeHttpRequest: NOOP,
    observeRpcRequest: NOOP,
    recordCacheEvent: NOOP,
    recordZmqEvent: NOOP,
    recordWebsocketConnection: NOOP,
    recordWebsocketMessage: NOOP
  };
}

function secondsFromHr(startedAt) {
  const diff = process.hrtime.bigint() - startedAt;
  return Number(diff) / HR_TO_SECONDS;
}

function classifyStatus(statusCode) {
  if (!Number.isFinite(statusCode)) {
    return 'unknown';
  }
  const bucket = Math.trunc(statusCode / 100);
  return `${bucket}xx`;
}

function normaliseRoute(req) {
  if (req.route?.path) {
    const base = req.baseUrl ?? '';
    return `${base}${req.route.path}` || req.route.path;
  }
  if (req.originalUrl) {
    const [path] = req.originalUrl.split('?');
    return path || req.originalUrl;
  }
  return 'unknown';
}

function createEnabledMetrics({ path, includeDefault }) {
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'bitcoin-explorer' });

  if (includeDefault) {
    collectDefaultMetrics({ register: registry });
  }

  const httpRequestsTotal = new Counter({
    name: 'explorer_http_requests_total',
    help: 'Total number of HTTP requests processed',
    labelNames: ['method', 'route', 'status'],
    registers: [registry]
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'explorer_http_request_duration_seconds',
    help: 'Observed HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry]
  });

  const rpcRequestsTotal = new Counter({
    name: 'explorer_rpc_requests_total',
    help: 'Bitcoin RPC requests executed grouped by outcome',
    labelNames: ['method', 'outcome'],
    registers: [registry]
  });

  const rpcRequestDurationSeconds = new Histogram({
    name: 'explorer_rpc_request_duration_seconds',
    help: 'Bitcoin RPC request duration in seconds',
    labelNames: ['method', 'outcome'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry]
  });

  const cacheEventsTotal = new Counter({
    name: 'explorer_cache_events_total',
    help: 'Cache events grouped by cache name and event type',
    labelNames: ['cache', 'event'],
    registers: [registry]
  });

  const zmqEventsTotal = new Counter({
    name: 'explorer_zmq_events_total',
    help: 'ZMQ listener events grouped by topic and event type',
    labelNames: ['topic', 'event'],
    registers: [registry]
  });

  const websocketConnectionsTotal = new Counter({
    name: 'explorer_websocket_connections_total',
    help: 'WebSocket connection events grouped by outcome',
    labelNames: ['event'],
    registers: [registry]
  });

  const websocketMessagesTotal = new Counter({
    name: 'explorer_websocket_messages_total',
    help: 'WebSocket messages broadcast grouped by type and status',
    labelNames: ['type', 'event'],
    registers: [registry]
  });

  async function handler(_req, res, next) {
    try {
      res.setHeader('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    } catch (error) {
      next?.(error);
    }
  }

  return {
    enabled: true,
    path,
    registry,
    handler,
    observeHttpRequest({ req, method, statusCode, startedAt }) {
      const route = normaliseRoute(req);
      const status = classifyStatus(statusCode);
      httpRequestsTotal.inc({ method, route, status });

      const durationSeconds = startedAt ? secondsFromHr(startedAt) : 0;
      httpRequestDurationSeconds.observe({ method, route, status }, durationSeconds);
    },
    observeRpcRequest({ method, outcome, durationMs }) {
      const safeOutcome = outcome === 'success' ? 'success' : 'error';
      rpcRequestsTotal.inc({ method, outcome: safeOutcome });
      rpcRequestDurationSeconds.observe({ method, outcome: safeOutcome }, (durationMs ?? 0) / MS_TO_SECONDS);
    },
    recordCacheEvent({ cache, event }) {
      if (!cache || !event) {
        return;
      }
      cacheEventsTotal.inc({ cache, event });
    },
    recordZmqEvent({ topic, event }) {
      if (!topic || !event) {
        return;
      }
      zmqEventsTotal.inc({ topic, event });
    },
    recordWebsocketConnection({ event }) {
      if (!event) {
        return;
      }
      websocketConnectionsTotal.inc({ event });
    },
    recordWebsocketMessage({ type, event }) {
      websocketMessagesTotal.inc({ type: type ?? 'unknown', event: event ?? 'broadcast' });
    }
  };
}

export function createMetrics(settings) {
  if (!settings?.enabled) {
    return createDisabledMetrics(settings?.path ?? '/metrics');
  }
  return createEnabledMetrics(settings);
}

export function createNoopRecorder() {
  return {
    observeHttpRequest: NOOP,
    observeRpcRequest: NOOP,
    recordCacheEvent: NOOP,
    recordZmqEvent: NOOP,
    recordWebsocketConnection: NOOP,
    recordWebsocketMessage: NOOP
  };
}

export const metrics = createMetrics(config.metrics);

export const metricsEnabled = metrics.enabled;

export function metricsHandler(req, res, next) {
  return metrics.handler(req, res, next);
}
