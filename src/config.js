import 'dotenv/config';
import { z } from 'zod';

const LogLevelEnum = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const ZmqUriSchema = z.string().regex(/^(?:tcp|ipc):\/\//, 'ZMQ endpoint must start with tcp:// or ipc://').optional();

const BooleanStringSchema = z.string().transform((value, ctx) => {
  const normalised = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalised)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off', ''].includes(normalised)) {
    return false;
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid boolean value: ${value}` });
  return z.NEVER;
});

const BooleanSchema = z.union([z.boolean(), BooleanStringSchema]);

const OptionalPortSchema = z.any().transform((value, ctx) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'WebSocket port must be a positive integer' });
    return z.NEVER;
  }
  return parsed;
});

const ConfigSchema = z.object({
  BITCOIN_RPC_URL: z.string().url(),
  BITCOIN_RPC_COOKIE: z.string().min(1).optional(),
  BITCOIN_RPC_USER: z.string().min(1).optional(),
  BITCOIN_RPC_PASSWORD: z.string().min(1).optional(),
  BITCOIN_RPC_TIMEOUT: z.coerce.number().int().positive().default(3000),
  BITCOIN_RPC_MAX_SOCKETS: z.coerce.number().int().positive().default(16),
  BITCOIN_ZMQ_BLOCK: ZmqUriSchema,
  BITCOIN_ZMQ_TX: ZmqUriSchema,
  APP_BIND: z.string().default('0.0.0.0'),
  APP_PORT: z.coerce.number().int().positive().default(28765),
  CACHE_TTL_TIP: z.coerce.number().int().nonnegative().default(5000),
  CACHE_TTL_BLOCK: z.coerce.number().int().nonnegative().default(600000),
  CACHE_TTL_TX: z.coerce.number().int().nonnegative().default(600000),
  CACHE_TTL_MEMPOOL: z.coerce.number().int().nonnegative().default(5000),
  LOG_LEVEL: LogLevelEnum.default('info'),
  LOG_PRETTY: BooleanSchema.default(false),
  LOG_DESTINATION: z.string().default('stdout'),
  LOG_REDACT: z.string().optional(),
  LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  FEATURE_MEMPOOL_DASHBOARD: BooleanSchema.default(true),
  METRICS_ENABLED: BooleanSchema.default(false),
  METRICS_PATH: z.string().regex(/^\//, 'Metrics path must start with /').default('/metrics'),
  METRICS_INCLUDE_DEFAULT: BooleanSchema.default(false),
  WEBSOCKET_ENABLED: BooleanSchema.default(false),
  WEBSOCKET_PATH: z.string().regex(/^\//, 'WebSocket path must start with /').default('/ws'),
  WEBSOCKET_PORT: OptionalPortSchema,
  FEATURE_ADDRESS_EXPLORER: BooleanSchema.default(false),
  ADDRESS_INDEX_PATH: z.string().default('./data/address-index'),
  ADDRESS_XPUB_GAP_LIMIT: z.coerce.number().int().positive().default(20),
  ADDRESS_INDEXER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  ADDRESS_PREVOUT_CACHE_MAX: z.coerce.number().int().positive().default(2000),
  ADDRESS_PREVOUT_CACHE_TTL: z.coerce.number().int().nonnegative().default(60000),
  ADDRESS_LEVEL_CACHE_MB: z.coerce.number().nonnegative().default(32),
  ADDRESS_LEVEL_WRITE_BUFFER_MB: z.coerce.number().nonnegative().default(8),
  ADDRESS_INDEXER_BATCH_BLOCKS: z.coerce.number().int().positive().default(1)
}).superRefine((data, ctx) => {
  const hasCookie = Boolean(data.BITCOIN_RPC_COOKIE);
  const hasUserPass = Boolean(data.BITCOIN_RPC_USER && data.BITCOIN_RPC_PASSWORD);
  if (!hasCookie && !hasUserPass) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide BITCOIN_RPC_COOKIE or BITCOIN_RPC_USER/BITCOIN_RPC_PASSWORD'
    });
  }
});

const cfg = ConfigSchema.parse(process.env);

function parseLogDestination(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value === 'stdout') {
    return { type: 'stdout' };
  }
  if (value.startsWith('file:')) {
    const filePath = value.slice('file:'.length).trim();
    if (!filePath) {
      throw new Error('LOG_DESTINATION file path is empty');
    }
    return { type: 'file', path: filePath };
  }
  if (value.startsWith('transport:')) {
    const target = value.slice('transport:'.length).trim();
    if (!target) {
      throw new Error('LOG_DESTINATION transport target is empty');
    }
    return { type: 'transport', target };
  }
  throw new Error(`Unsupported LOG_DESTINATION value: ${value}`);
}

function parseRedactPaths(raw) {
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function mbToBytes(megabytes) {
  return Math.max(0, Math.trunc(megabytes * 1024 * 1024));
}

let logDestination;
try {
  logDestination = parseLogDestination(cfg.LOG_DESTINATION);
} catch (error) {
  console.warn(`[config] ${error.message}; falling back to stdout logging`);
  logDestination = { type: 'stdout' };
}

const logRedactPaths = parseRedactPaths(cfg.LOG_REDACT);

export const config = Object.freeze({
  app: {
    bind: cfg.APP_BIND,
    port: cfg.APP_PORT
  },
  cache: {
    tip: cfg.CACHE_TTL_TIP,
    block: cfg.CACHE_TTL_BLOCK,
    tx: cfg.CACHE_TTL_TX,
    mempool: cfg.CACHE_TTL_MEMPOOL
  },
  rpc: {
    url: cfg.BITCOIN_RPC_URL,
    cookiePath: cfg.BITCOIN_RPC_COOKIE ?? null,
    username: cfg.BITCOIN_RPC_USER ?? null,
    password: cfg.BITCOIN_RPC_PASSWORD ?? null,
    timeout: cfg.BITCOIN_RPC_TIMEOUT,
    maxSockets: cfg.BITCOIN_RPC_MAX_SOCKETS
  },
  zmq: {
    blockEndpoint: cfg.BITCOIN_ZMQ_BLOCK ?? null,
    txEndpoint: cfg.BITCOIN_ZMQ_TX ?? null
  },
  logging: {
    level: cfg.LOG_LEVEL,
    pretty: cfg.LOG_PRETTY,
    destination: logDestination,
    redactPaths: logRedactPaths,
    sampleRate: cfg.LOG_SAMPLE_RATE
  },
  features: {
    mempoolDashboard: cfg.FEATURE_MEMPOOL_DASHBOARD,
    websocket: cfg.WEBSOCKET_ENABLED,
    addressExplorer: cfg.FEATURE_ADDRESS_EXPLORER
  },
  metrics: {
    enabled: cfg.METRICS_ENABLED,
    path: cfg.METRICS_PATH,
    includeDefault: cfg.METRICS_INCLUDE_DEFAULT
  },
  websocket: {
    enabled: cfg.WEBSOCKET_ENABLED,
    path: cfg.WEBSOCKET_PATH,
    port: cfg.WEBSOCKET_PORT
  },
  address: {
    enabled: cfg.FEATURE_ADDRESS_EXPLORER,
    indexPath: cfg.ADDRESS_INDEX_PATH,
    xpubGapLimit: cfg.ADDRESS_XPUB_GAP_LIMIT,
    indexerConcurrency: cfg.ADDRESS_INDEXER_CONCURRENCY,
    prevoutCacheMax: cfg.ADDRESS_PREVOUT_CACHE_MAX,
    prevoutCacheTtl: cfg.ADDRESS_PREVOUT_CACHE_TTL,
    levelCacheBytes: mbToBytes(cfg.ADDRESS_LEVEL_CACHE_MB),
    levelWriteBufferBytes: mbToBytes(cfg.ADDRESS_LEVEL_WRITE_BUFFER_MB),
    batchBlockCount: cfg.ADDRESS_INDEXER_BATCH_BLOCKS
  }
});
