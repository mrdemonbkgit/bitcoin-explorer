# Slim Bitcoin Explorer (Node.js)

A lightweight, LAN-first Bitcoin block explorer that runs alongside your own Bitcoin Core node. It serves server-rendered HTML with optional JSON APIs, streams live updates via WebSockets, exports Prometheus metrics, and (when enabled) maintains a local LevelDB index for address/xpub lookups—all without external services.

## Stack
- Node.js 24.8.0 (ES modules)
- Express 5 for HTTP routing
- Nunjucks for server-side rendering
- Axios with keep-alive agents for Bitcoin Core JSON-RPC
- lru-cache for in-memory TTL caching
- level for the optional address/xpub index
- bitcoinjs-lib + bip32 for key/address derivation
- ws for LAN-only WebSocket pushes
- prom-client for the metrics exporter
- pino for structured logging
- dotenv + zod for strict environment configuration

## Features
- **Home dashboard** – chain tip, mempool counters, fee estimates, and global search.
- **Blocks & transactions** – detailed block pages (height/hash) and transaction breakdowns with per-input/output addresses plus RBF hinting.
- **Smart search** – accepts heights, block hashes, txids, addresses, and xpubs (routes to the appropriate view).
- **Mempool dashboard** *(feature flagged)* – live histogram and recent transactions, refreshed via ZMQ/WebSockets when enabled.
- **Address explorer** *(feature flagged)* – LevelDB-backed balances, UTXOs, and paginated history for any address.
- **Xpub explorer** *(feature flagged)* – derives the first `ADDRESS_XPUB_GAP_LIMIT` receive/change paths with balances and activity.
- **JSON API** – `/api/v1/*` endpoints mirror the SSR views for automation and integrations.
- **Prometheus metrics** *(feature flagged)* – `/metrics` exposes HTTP/RPC/cache/indexer counters and histograms.
- **WebSocket notifications** *(feature flagged)* – LAN clients receive near-real-time tip, mempool, and tx updates powered by ZMQ.
- **Regtest smoke suite** – `npm run test:regtest` spins up `bitcoind -regtest` to validate cache busting, mempool, address explorer, and logging end-to-end.

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
- `npm run test` / `npm run coverage` — Vitest unit tests plus Supertest-backed integration tests. When running without a reachable Bitcoin Core node, set `FEATURE_ADDRESS_EXPLORER=false` so the LevelDB indexer stays disabled.
- `npm run test:regtest` — End-to-end smoke suite against a local `bitcoind -regtest` (requires `bitcoind` binary). Set `REGTEST_SCRAPE_METRICS=true` to scrape `/metrics`, `REGTEST_ADDRESS_CHECK=true` to exercise the address/xpub explorer (the harness now provisions an isolated LevelDB path and waits for the indexer to catch up), and interrupt/restart the app mid-sync to confirm checkpoints resume cleanly.
- `npm run build` — Creates `dist/` with runtime assets and production dependencies
- `npm run bench:address` — Seeds a regtest node and captures LevelDB ingest/read metrics (writes `bench/current-results.json`)
- `npm run bench:compare` — Compares the latest metrics against the checked-in baseline (`bench/leveldb-results.json`). Tune relative thresholds with `BENCH_MAX_*_DELTA` or add `BENCH_MAX_*_ABS` (milliseconds) to tolerate tiny absolute swings during CI runs.
- `.github/workflows/ci.yml` — GitHub Actions workflow running lint → typecheck → coverage, audits prod deps, and uploads build + coverage artifacts
- Scheduled CI also runs `benchmark-indexer`, which executes the benchmark harness nightly and fails if ingest or read latencies exceed the configured thresholds; grab the `address-indexer-benchmark` artifact on GitHub to inspect the raw numbers.
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
BITCOIN_RPC_MAX_SOCKETS=16
METRICS_ENABLED=false
METRICS_PATH=/metrics
METRICS_INCLUDE_DEFAULT=false
WEBSOCKET_ENABLED=false
WEBSOCKET_PATH=/ws
WEBSOCKET_PORT=
FEATURE_ADDRESS_EXPLORER=false
ADDRESS_INDEX_PATH=./data/address-index
ADDRESS_XPUB_GAP_LIMIT=20
ADDRESS_INDEXER_CONCURRENCY=4
ADDRESS_PREVOUT_CACHE_MAX=2000
ADDRESS_PREVOUT_CACHE_TTL=60000
ADDRESS_LEVEL_CACHE_MB=32
ADDRESS_LEVEL_WRITE_BUFFER_MB=8
GITHUB_TOKEN=
```

### Realtime Updates, Logging, Metrics & WebSockets
- Set `BITCOIN_ZMQ_BLOCK` / `BITCOIN_ZMQ_TX` to enable sub-second cache busting via Bitcoin Core's ZMQ notifications (e.g., `tcp://127.0.0.1:28332`). Without these values the explorer falls back to TTL-based polling.
- Tune cache behaviour with `CACHE_TTL_MEMPOOL` alongside existing tip/block/tx TTLs.
- Scale JSON-RPC connection pooling via `BITCOIN_RPC_MAX_SOCKETS` (default 16) when raising `BITCOIN_RPC_TIMEOUT` for long-running indexer batches; the HTTP agent keeps connections warm for the prevout workers.
- Structured logs emit JSON via `pino`; adjust `LOG_LEVEL` (`trace`→`fatal`), toggle pretty printing with `LOG_PRETTY=true`, choose destinations with `LOG_DESTINATION` (`stdout`, `file:/path/to/log.jsonl`), redact sensitive fields via `LOG_REDACT`, and down-sample verbose logs using `LOG_SAMPLE_RATE`.
- Toggle the mempool dashboard entirely via `FEATURE_MEMPOOL_DASHBOARD=false` if operators prefer to disable the route.
- Enable the Prometheus exporter with `METRICS_ENABLED=true`. The endpoint defaults to `/metrics` on the main bind; adjust via `METRICS_PATH`. Set `METRICS_INCLUDE_DEFAULT=true` to expose Node.js process metrics.
- Enable LAN-only WebSocket pushes with `WEBSOCKET_ENABLED=true`. Clients use the configured `WEBSOCKET_PATH` (default `/ws`) and reuse the main server port unless `WEBSOCKET_PORT` is set. When active, the home and mempool pages hydrate with near-real-time updates while remaining fully functional without WebSockets.
- Enable the address/xpub explorer with `FEATURE_ADDRESS_EXPLORER=true`. The indexer stores data in `ADDRESS_INDEX_PATH` (LevelDB directory), uses `ADDRESS_INDEXER_CONCURRENCY` to control prevout fetch workers (default 4), keeps short-lived prevout responses in-memory via `ADDRESS_PREVOUT_CACHE_MAX` / `ADDRESS_PREVOUT_CACHE_TTL`, and derives xpub branches using `ADDRESS_XPUB_GAP_LIMIT` (default 20). LevelDB tuning defaults to `ADDRESS_LEVEL_CACHE_MB=32` / `ADDRESS_LEVEL_WRITE_BUFFER_MB=8`; adjust upward for SSD-backed deployments if memory allows. Initial sync walks the chain via RPC (checkpoints persist after restarts); expect runtime proportional to chain size.
- Supply `GITHUB_TOKEN` when automation needs GitHub API access (e.g., CI scripts or release tooling). Leave it blank for standard LAN deployments.

## Available Routes
- `/` — Home dashboard with chain tip, mempool status, fee estimates, and search box
- `/block/:id` — Block details by height or hash with paginated txid listing
- `/tx/:txid` — Transaction view with inputs, outputs, resolved addresses, totals, and RBF hint
- `/search?q=` — Smart search that routes to the relevant block or transaction
- `/mempool` — Live mempool dashboard with fee histogram and recent transactions (requires ZMQ for sub-second invalidation)
- `/address/:address` — Address summary (received/sent/balance), UTXOs, and paginated transaction history (requires address explorer feature flag)
- `/xpub/:xpub` — Derived address summary for the first `ADDRESS_XPUB_GAP_LIMIT` paths, with balances and transaction counts

### JSON API
- `/api/v1/tip` — Chain tip summary (JSON payload mirroring the home page data)
- `/api/v1/block/:id` — Block metadata + paginated txids (`page` query supported)
- `/api/v1/tx/:txid` — Transaction details including resolved addresses, computed totals, and RBF hint
- `/api/v1/mempool` — Mempool snapshot (histogram + recent transactions, `page` query supported)
- `/api/v1/address/:address` — Address summary, UTXOs, and transactions (`page`/`pageSize` query supported)
- `/api/v1/xpub/:xpub` — Xpub-derived address summary and balances (limited by `ADDRESS_XPUB_GAP_LIMIT`)
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
│   │   ├── addressIndexer.js
│   │   ├── cacheEvents.js
│   │   ├── logger.js
│   │   └── zmqListener.js
│   ├── middleware
│   │   └── requestLogger.js
│   ├── routes
│   │   └── api
│   │       ├── address.js
│   │       ├── block.js
│   │       ├── index.js
│   │       ├── mempool.js
│   │       ├── tip.js
│   │       ├── tx.js
│   │       └── xpub.js
│   ├── rpc.js
│   ├── server.js
│   └── services
│       ├── addressExplorerService.js
│       ├── bitcoinService.js
│       └── mempoolService.js
├── views
│   ├── address.njk
│   ├── block.njk
│   ├── error.njk
│   ├── home.njk
│   ├── layout.njk
│   ├── mempool.njk
│   ├── tx.njk
│   └── xpub.njk
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
    │   ├── api.address.test.js
    │   ├── api.test.js
    │   ├── metricsRoute.test.js
    │   ├── parity.test.js
    │   ├── server.test.js
    │   └── websocket.test.js
    ├── setup-env.js
    └── unit
        ├── bitcoinService.test.js
        ├── mempoolService.test.js
        └── requestLogger.test.js
```

## Notes
- `npm run build` now packages the app (with production dependencies) into `dist/` for deployment.
- `/mempool` provides a live dashboard that refreshes via ZMQ when configured, falling back to TTL-based cache expiry otherwise.
- Structured JSON logs (`pino`) capture request/RPC context; tune verbosity with `LOG_LEVEL`, switch destinations via `LOG_DESTINATION`, and dial sampling/redaction with `LOG_SAMPLE_RATE` / `LOG_REDACT`.
- Routes render HTML responses; JSON APIs can still be layered on later if desired.
- Mid-term API + SSR split planning lives in `docs/EXPANSION.md` (see Mid-Term) with implementation details in `docs/design/api-ssr-plan.md`.

Refer to `docs/PRD.md` for product requirements, `docs/RUNBOOK.md` for operational guidance, and `docs/EXPANSION.md` for longer-term roadmap ideas.
