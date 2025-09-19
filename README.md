# Slim Bitcoin Explorer (Node.js)

A lightweight Bitcoin block explorer that runs alongside your own Bitcoin Core node. The application is built with Node.js 24.8, Express 5, server-rendered Nunjucks views, and direct JSON-RPC calls—no databases or background indexers.

## Stack
- Node.js 24.8.0 (ES modules)
- Express 5 for HTTP routing
- Nunjucks templates for server-side rendering
- Axios with keep-alive agents for Bitcoin Core JSON-RPC
- lru-cache for in-memory TTL caching
- dotenv + zod for strict environment configuration

## Quickstart
```bash
# install dependencies
npm install

# copy and edit environment configuration
cp docs/env.sample .env
$EDITOR .env

# run with live reload (Node 24+)
npm run dev

# or start the server without file watching
npm start

# run quality gates
npm run lint
npm run typecheck
npm run test
npm run build
```

## Quality & CI
- `npm run lint` — ESLint baseline for Node 24 with `eslint-plugin-n`
- `npm run typecheck` — TypeScript `--noEmit` with `checkJs` coverage
- `npm run test` / `npm run coverage` — Vitest unit tests plus Supertest-backed integration tests
- `npm run test:regtest` — End-to-end smoke suite against a local `bitcoind -regtest` (requires `bitcoind` binary)
- `npm run build` — Creates `dist/` with runtime assets and production dependencies
- `.github/workflows/ci.yml` — GitHub Actions workflow running lint → typecheck → coverage, audits prod deps, and uploads build + coverage artifacts
- See `docs/TESTING.md` for a step-by-step testing checklist covering structured logging, ZMQ cache busting, the mempool dashboard, and the regtest smoke suite.

The service listens on the host/port defined in `.env` (`0.0.0.0:28765` by default). Bitcoin Core must be reachable at the configured RPC URL with cookie authentication enabled.

## Environment
Create `.env` in the project root based on `docs/env.sample`:
```
BITCOIN_RPC_URL=http://127.0.0.1:8332

# Option A: cookie-based auth (default when running alongside Bitcoin Core)
BITCOIN_RPC_COOKIE=/home/bitcoin/.bitcoin/.cookie

# Option B: static credentials from bitcoin.conf
BITCOIN_RPC_USER=<rpcuser>
BITCOIN_RPC_PASSWORD=<rpcpassword>

APP_BIND=0.0.0.0
APP_PORT=28765
CACHE_TTL_TIP=5000
CACHE_TTL_BLOCK=600000
CACHE_TTL_TX=600000
CACHE_TTL_MEMPOOL=5000
BITCOIN_RPC_TIMEOUT=3000
METRICS_ENABLED=false
METRICS_PATH=/metrics
METRICS_INCLUDE_DEFAULT=false
```

### Realtime Updates, Logging & Metrics
- Set `BITCOIN_ZMQ_BLOCK` / `BITCOIN_ZMQ_TX` to enable sub-second cache busting via Bitcoin Core's ZMQ notifications (e.g., `tcp://127.0.0.1:28332`). Without these values the explorer falls back to TTL-based polling.
- Tune cache behaviour with `CACHE_TTL_MEMPOOL` alongside existing tip/block/tx TTLs.
- Structured logs emit JSON via `pino`; adjust `LOG_LEVEL` (`trace`→`fatal`) and toggle pretty printing with `LOG_PRETTY=true` during local development.
- Toggle the mempool dashboard entirely via `FEATURE_MEMPOOL_DASHBOARD=false` if operators prefer to disable the route.
- Enable the Prometheus exporter with `METRICS_ENABLED=true`. The endpoint defaults to `/metrics` on the main bind; adjust via `METRICS_PATH`. Set `METRICS_INCLUDE_DEFAULT=true` to expose Node.js process metrics.

## Available Routes
- `/` — Home dashboard with chain tip, mempool status, fee estimates, and search box
- `/block/:id` — Block details by height or hash with paginated txid listing
- `/tx/:txid` — Transaction view with inputs, outputs, totals, and RBF hint
- `/search?q=` — Smart search that routes to the relevant block or transaction
- `/mempool` — Live mempool dashboard with fee histogram and recent transactions (requires ZMQ for sub-second invalidation)

### JSON API
- `/api/v1/tip` — Chain tip summary (JSON payload mirroring the home page data)
- `/api/v1/block/:id` — Block metadata + paginated txids (`page` query supported)
- `/api/v1/tx/:txid` — Transaction details including computed totals and RBF hint
- `/api/v1/mempool` — Mempool snapshot (histogram + recent transactions, `page` query supported)
- JSON errors follow the shape `{ "error": { code, type, message }, "meta": {} }`
- Full examples and testing notes live in `docs/API.md`

## Project Layout
```
├── AGENTS.md
├── README.md
├── package.json
├── scripts
│   ├── build.js
│   └── regtest
│       └── smoke.js
├── src
│   ├── cache.js
│   ├── config.js
│   ├── errors.js
│   ├── infra
│   │   ├── cacheEvents.js
│   │   ├── logger.js
│   │   └── zmqListener.js
│   ├── middleware
│   │   └── requestLogger.js
│   ├── rpc.js
│   ├── server.js
│   └── services
│       ├── bitcoinService.js
│       └── mempoolService.js
├── views
│   ├── block.njk
│   ├── error.njk
│   ├── home.njk
│   ├── layout.njk
│   ├── mempool.njk
│   └── tx.njk
├── docs
│   ├── env.sample
│   ├── EXPANSION.md
│   ├── PRD.md
│   ├── RUNBOOK.md
│   ├── TESTING.md
│   └── design
│       ├── api-ssr-plan.md
│       └── near-term-phase1.md
└── test
    ├── integration
    │   └── server.test.js
    ├── setup-env.js
    └── unit
        ├── bitcoinService.test.js
        ├── mempoolService.test.js
        └── requestLogger.test.js
```

## Notes
- `npm run build` now packages the app (with production dependencies) into `dist/` for deployment.
- `/mempool` provides a live dashboard that refreshes via ZMQ when configured, falling back to TTL-based cache expiry otherwise.
- Structured JSON logs (`pino`) capture request/RPC context; tune verbosity with `LOG_LEVEL`.
- Routes render HTML responses; JSON APIs can still be layered on later if desired.
- Mid-term API + SSR split planning lives in `docs/EXPANSION.md` (see Mid-Term) with implementation details in `docs/design/api-ssr-plan.md`.

Refer to `docs/PRD.md` for product requirements, `docs/RUNBOOK.md` for operational guidance, and `docs/EXPANSION.md` for longer-term roadmap ideas.
