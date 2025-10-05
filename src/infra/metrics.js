import { Counter, Histogram, Registry, collectDefaultMetrics, Gauge } from 'prom-client';
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
    recordWebsocketMessage: NOOP,
    recordAddressIndexerBlockDuration: NOOP,
    recordAddressIndexerPrevoutDuration: NOOP,
    recordAddressIndexerSyncStatus: NOOP
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

const INDEXER_STATES = ['disabled', 'unknown', 'starting', 'catching_up', 'synced', 'degraded', 'error'];

function sanitiseNumber(value, fallback = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
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

  const addressIndexerBlockDurationSeconds = new Histogram({
    name: 'explorer_address_indexer_block_duration_seconds',
    help: 'Observed block processing duration for the address indexer',
    labelNames: ['outcome'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry]
  });

  const addressIndexerPrevoutDurationSeconds = new Histogram({
    name: 'explorer_address_indexer_prevout_duration_seconds',
    help: 'Observed prevout fetch duration for the address indexer',
    labelNames: ['source'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [registry]
  });

  const addressIndexerBlocksRemaining = new Gauge({
    name: 'explorer_address_indexer_blocks_remaining',
    help: 'Blocks remaining before the address indexer catches up to the chain tip',
    registers: [registry]
  });

  const addressIndexerEtaSeconds = new Gauge({
    name: 'explorer_address_indexer_sync_eta_seconds',
    help: 'Estimated seconds remaining for the address indexer to complete catch-up',
    registers: [registry]
  });

  const addressIndexerProgressPercent = new Gauge({
    name: 'explorer_address_indexer_progress_percent',
    help: 'Address indexer progress percentage (0-100)',
    registers: [registry]
  });

  const addressIndexerTipHeight = new Gauge({
    name: 'explorer_address_indexer_tip_height',
    help: 'Latest chain tip height observed when recording address indexer status',
    registers: [registry]
  });

  const addressIndexerLastProcessedHeight = new Gauge({
    name: 'explorer_address_indexer_last_processed_height',
    help: 'Last processed block height stored by the address indexer',
    registers: [registry]
  });

  const addressIndexerStateGauge = new Gauge({
    name: 'explorer_address_indexer_state',
    help: 'Current address indexer state indicator (1 means active state)',
    labelNames: ['state'],
    registers: [registry]
  });

  const addressIndexerSyncFlag = new Gauge({
    name: 'explorer_address_indexer_sync_in_progress',
    help: 'Whether the address indexer is actively syncing (1) or idle (0)',
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
    },
    recordAddressIndexerBlockDuration({ outcome, durationMs }) {
      const safeOutcome = outcome === 'success' ? 'success' : 'error';
      addressIndexerBlockDurationSeconds.observe({ outcome: safeOutcome }, (durationMs ?? 0) / MS_TO_SECONDS);
    },
    recordAddressIndexerPrevoutDuration({ source, durationMs }) {
      const safeSource = source ?? 'unknown';
      addressIndexerPrevoutDurationSeconds.observe({ source: safeSource }, (durationMs ?? 0) / MS_TO_SECONDS);
    },
    recordAddressIndexerSyncStatus({
      blocksRemaining,
      progressPercent,
      estimatedCompletionSeconds,
      state,
      tipHeight,
      lastProcessedHeight,
      syncInProgress
    }) {
      const remaining = Math.max(0, sanitiseNumber(blocksRemaining));
      const progress = Math.min(100, Math.max(0, sanitiseNumber(progressPercent)));
      const etaSeconds = Math.max(0, sanitiseNumber(estimatedCompletionSeconds));

      addressIndexerBlocksRemaining.set(remaining);
      addressIndexerProgressPercent.set(progress);
      addressIndexerEtaSeconds.set(etaSeconds);
      addressIndexerTipHeight.set(Math.max(0, sanitiseNumber(tipHeight)));
      addressIndexerLastProcessedHeight.set(Math.max(0, sanitiseNumber(lastProcessedHeight)));
      addressIndexerSyncFlag.set(syncInProgress ? 1 : 0);

      const activeState = state && INDEXER_STATES.includes(state) ? state : 'unknown';
      for (const label of INDEXER_STATES) {
        addressIndexerStateGauge.labels(label).set(label === activeState ? 1 : 0);
      }
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
    recordWebsocketMessage: NOOP,
    recordAddressIndexerBlockDuration: NOOP,
    recordAddressIndexerPrevoutDuration: NOOP,
    recordAddressIndexerSyncStatus: NOOP
  };
}

export const metrics = createMetrics(config.metrics);

export const metricsEnabled = metrics.enabled;

export function metricsHandler(req, res, next) {
  return metrics.handler(req, res, next);
}
