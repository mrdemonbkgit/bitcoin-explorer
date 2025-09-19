import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  BITCOIN_RPC_URL: z.string().url(),
  BITCOIN_RPC_COOKIE: z.string().min(1).optional(),
  BITCOIN_RPC_USER: z.string().min(1).optional(),
  BITCOIN_RPC_PASSWORD: z.string().min(1).optional(),
  BITCOIN_RPC_TIMEOUT: z.coerce.number().int().positive().default(3000),
  APP_BIND: z.string().default('0.0.0.0'),
  APP_PORT: z.coerce.number().int().positive().default(28765),
  CACHE_TTL_TIP: z.coerce.number().int().nonnegative().default(5000),
  CACHE_TTL_BLOCK: z.coerce.number().int().nonnegative().default(600000),
  CACHE_TTL_TX: z.coerce.number().int().nonnegative().default(600000)
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
    tx: cfg.CACHE_TTL_TX
  },
  rpc: {
    url: cfg.BITCOIN_RPC_URL,
    cookiePath: cfg.BITCOIN_RPC_COOKIE ?? null,
    username: cfg.BITCOIN_RPC_USER ?? null,
    password: cfg.BITCOIN_RPC_PASSWORD ?? null,
    timeout: cfg.BITCOIN_RPC_TIMEOUT
  }
});
