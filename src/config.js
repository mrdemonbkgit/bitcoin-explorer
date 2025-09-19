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
  FEATURE_MEMPOOL_DASHBOARD: BooleanSchema.default(true),
  METRICS_ENABLED: BooleanSchema.default(false),
  METRICS_PATH: z.string().regex(/^\//, 'Metrics path must start with /').default('/metrics'),
  METRICS_INCLUDE_DEFAULT: BooleanSchema.default(false),
  WEBSOCKET_ENABLED: BooleanSchema.default(false),
  WEBSOCKET_PATH: z.string().regex(/^\//, 'WebSocket path must start with /').default('/ws'),
  WEBSOCKET_PORT: OptionalPortSchema
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
    timeout: cfg.BITCOIN_RPC_TIMEOUT
  },
  zmq: {
    blockEndpoint: cfg.BITCOIN_ZMQ_BLOCK ?? null,
    txEndpoint: cfg.BITCOIN_ZMQ_TX ?? null
  },
  logging: {
    level: cfg.LOG_LEVEL,
    pretty: cfg.LOG_PRETTY
  },
  features: {
    mempoolDashboard: cfg.FEATURE_MEMPOOL_DASHBOARD,
    websocket: cfg.WEBSOCKET_ENABLED
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
  }
});
