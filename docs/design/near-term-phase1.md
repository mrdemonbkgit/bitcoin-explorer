# Near-Term Bundle — Phase 1 Design Notes

## Overview
Phase 1 covers discovery and design for the near-term expansion bundle (structured logging, ZMQ cache busting, mempool dashboard, regtest smoke tests). This document captures assumptions, open questions, and proposed decisions before implementation begins.

## ZMQ Integration
### Goals
- Subscribe to Bitcoin Core ZMQ topics that indicate new blocks and transactions.
- Trigger targeted cache invalidation with minimal latency.
- Keep the feature optional and safe for operators without ZMQ enabled.

### Topics & Payloads
- `rawblock`: delivers raw block bytes; we only need the hash. Proposed approach:
  - Parse the first 80 bytes (block header) to extract the hash, or run `bitcoin-cli getblock` when notification arrives.
  - Maintain a lightweight decoder utility reusable by future features (e.g., block preview).
- `rawtx`: raw transaction bytes; we need the txid to clear tx caches and update mempool metrics.
  - Use double SHA256 to derive txid from raw payload, or fall back to JSON-RPC `getrawtransaction` if decoding fails.

### Configuration
- Add optional env variables:
  - `BITCOIN_ZMQ_BLOCK=ipc:///path/to/blocks` (or TCP URL)
  - `BITCOIN_ZMQ_TX=ipc:///path/to/tx`
- Validation rules:
  - URLs must use `tcp://` or `ipc://` schemes.
  - Both entries optional; enabling one without the other is allowed.
- Runtime behaviour:
  - When neither is set, the listener stays disabled and caches rely on TTL.
  - When enabled, spawn a background subscriber that reconnects with exponential backoff (1s → 32s).

### Subscriber Lifecycle
- Use `zeromq` npm package (`sock = new zmq.Subscriber(); sock.connect(url); sock.subscribe('rawblock');`).
- Run listener in its own async loop; share a bounded queue with application layer to avoid blocking.
- Observability: structured log entries for connect/disconnect, message counts, and errors.
- Graceful shutdown: close sockets on SIGINT/SIGTERM (align with future Phase 3 logging).

### Security & Networking
- Document requirement for Core to expose ZMQ; warn about binding to LAN vs. localhost.
- Provide sample Core config in RUNBOOK updates (`zmqpubrawblock=tcp://127.0.0.1:28332`).

### Open Questions
- Do we support multiple block/tx endpoints (failover)? For Phase 1, no—single endpoint per topic.
- Should we throttle invalidations to avoid storms? Proposed: yes, collapse notifications within a 100ms window.

## Cache Strategy
### Current State
- LRU caches for tip, block, tx keyed by hash/height with TTL.
- No pipeline for invalidation besides TTL expiry.

### Desired Behaviour
- On new block notification:
  - Clear `tip` summary cache.
  - Remove cached block entry if matching hash or previous tip.
  - Drop transaction caches referencing confirmed txs if feasible (stretch goal, otherwise rely on TTL).
- On new transaction notification:
  - Invalidate mempool-related caches (Phase 3 will introduce), optional purge of `tx` cache for same txid.

### Implementation Approach
- Introduce `cacheEvents` module exposing `subscribe(event, handler)` and `emit(event, payload)`.
- ZMQ listener converts raw notifications into events (`block:new`, `tx:new`).
- Cache layer registers handlers to clear relevant entries.
- Support manual injection for tests (e.g., fake notifications).

### Resilience
- If listener fails, caches continue using TTL (log warning but do not crash server).
- Provide metrics/log counts for invalidations (wired into structured logging).

### Testing Strategy
- Unit tests for event bus ensuring handlers fire.
- Integration tests mocking ZMQ events to confirm caches are cleared.
- Document manual QA: start Core with ZMQ, mine block, verify dashboard refresh.

## Mempool Dashboard UX
### Objectives
- Present live mempool health at a glance for LAN operators without overwhelming detail.
- Offer quick drill-down into recent transactions and fee tiers while keeping server-rendered simplicity.

### Page Structure (SSR)
1. **Header summary**: total tx count, virtual size, fee median, last updated timestamp.
2. **Fee histogram**: bucketed fee rates (sat/vB) grouped into configurable ranges (e.g., 1-5, 6-10, 11-20, 21-50, 50+). Rendered as simple bar chart using HTML/CSS (no JS required) with numeric labels.
3. **Recent transactions table**: last N transactions (e.g., 25) with txid, fee rate, vsize, arrival age, RBF flag. Link txid to existing `/tx/:id` page.
4. **Actions panel**: manual refresh control and optional download of raw mempool snapshot (JSON) for power users.

### Data Acquisition
- Primary RPCs: `getmempoolinfo`, `getrawmempool true`, optionally `getmempoolentry` for richer metadata.
- Aggregation strategy:
  - Cache mempool snapshot in memory (new cache key) with short TTL (e.g., 5s) and invalidation from ZMQ `tx:new` events.
  - Compute histogram server-side during data fetch to minimise template logic.
- Pagination: Provide `?page=` with default 1, show 25 tx per page sourced from sorted list (by arrival time).

### Accessibility & Performance Considerations
- Use semantic tables and aria labels for histograms.
- Lazy compute heavy metrics only when dashboard route invoked; avoid blocking other routes by performing RPC calls in `Promise.all`.
- Document expected CPU cost; allow environment flag to disable page if operator uninterested (e.g., `FEATURE_MEMPOOL_DASHBOARD=false`).

### Open Questions
- Should we enrich data with `fee` vs `feerate`? Need measurement during implementation.
- Do we display unconfirmed ancestors? Defer to later iteration.

## Structured Logging Design
### Objectives
- Emit machine-readable logs (JSON) for HTTP requests, RPC calls, and background workers.
- Maintain human-friendly readability with formatting tools (e.g., `jq`).

### Log Schema (initial proposal)
```.json
{
  "timestamp": ISO8601 string,
  "level": "info" | "error" | "warn" | "debug",
  "message": string,
  "context": {
    "requestId": string (uuid per HTTP request),
    "route": string,
    "method": string,
    "status": number,
    "durationMs": number,
    "cache": {
      "name": string,
      "event": "hit" | "miss" | "invalidate"
    },
    "rpc": {
      "method": string,
      "durationMs": number,
      "errorCode": number | null
    },
    "zmq": {
      "topic": "rawblock" | "rawtx",
      "bytes": number
    }
  }
}
```

### Library Choice
- Evaluate `pino` vs handcrafted serializer:
  - `pino` advantages: performance, ecosystem tooling.
  - Hand-rolled: no extra dependency, but more maintenance.
- Proposal: adopt `pino` with `pino-pretty` optional for local dev; treat as runtime dependency because logging is core functionality.

### Request Lifecycle Integration
- Middleware generates `requestId` (UUID v4), attaches to `res.locals`, logs start and completion (status, duration, cache hit flag if available).
- RPC wrapper logs each call at `debug` with method/duration; logs `error` on failure with sanitized message.
- ZMQ listener logs connect/disconnect at `info`, message handling at `debug`, error conditions at `warn`/`error`.

### Configuration
- `LOG_LEVEL` env variable controlling minimum level (default `info`).
- `LOG_PRETTY=false` env to enable developer-friendly formatting when running locally.
- Future consideration: `LOG_DESTINATION` to allow piping to file/syslog.

### Testing & Validation
- Unit tests verifying middleware attaches requestId and emits structured payload.
- Snapshot tests for log structure (strip timestamp) using Vitest.
- Document rotation guidance in RUNBOOK (e.g., rely on journald/systemd) and absence of PII in logs.

## Next Steps
- Prototype subscriber in isolation to validate payload parsing during Phase 2 spikes.
- Update RUNBOOK/README with new configuration guidance once implementation is underway.
- Finalise regtest smoke test plan (see next section).

- Transition follow-up work into the Mid-Term API + SSR plan documented in `docs/design/api-ssr-plan.md` (see `docs/EXPANSION.md`).
## Regtest Smoke Test Plan
### Objectives
- Verify explorer behaviour end-to-end against a predictable Bitcoin Core regtest network during CI.
- Catch regressions in cache invalidation, mempool dashboards, and structured logging before release.

### Tooling Evaluation
- Prefer Docker-based regtest (`ruimarinho/bitcoin-core` image or official Docker Hub release) for reproducibility.
- Alternative: download Core binaries and launch `bitcoind -regtest`; encapsulate setup in npm script for local developers.
- Use wrapper utility (Node child_process with `bitcoin-cli`) or the `bitcoin-core-client` npm library for JSON-RPC interactions.

### Test Scenarios
1. **Startup**: Launch Core with ZMQ + RPC enabled, wait for readiness (poll `getblockchaininfo`).
2. **Block Flow**: Mine one block via `generatetoaddress`, verify explorer tip summary updates and caches invalidate.
3. **Transaction Flow**: Broadcast raw transaction, ensure mempool dashboard displays entry and structured log captures `tx:new`.
4. **Confirmation Flow**: Mine an additional block, confirm transaction leaves dashboard and `/tx/` view reports confirmations.
5. **Logging Check**: Capture stdout/stderr during tests; assert JSON structure contains `requestId`, `route`, and `rpc.method`.

### CI Integration
- Add GitHub Actions job (nightly or opt-in label) invoking regtest script after unit/integration tests.
- Cache Docker layers/binaries; set job timeout (e.g., 10 minutes).
- Upload artifacts on failure: explorer logs, regtest debug output, mempool snapshot JSON.

### Configuration Requirements
- Provide env vars: `BITCOIN_RPC_URL`, `BITCOIN_RPC_COOKIE` (pointing to mounted cookie file), `BITCOIN_ZMQ_BLOCK`, `BITCOIN_ZMQ_TX`.
- Expose container ports 18443 (RPC) and 28332/28333 (ZMQ) to runner network; clean up containers after run.

### Risks & Mitigations
- **Runtime**: keep scenario count minimal; run sequentially to avoid race conditions.
- **Flakiness**: wrap RPC calls with retries/backoff; detect Core readiness before hitting endpoints.
- **Resource contention**: ensure job uses matrix flag so default CI remains fast; allow developers to skip locally via env toggle.

### Deliverables
- Automation scripts (`scripts/regtest/*.js`), reusable for CI and local debugging.
- Vitest/Supertest suite tagged for regtest.
- Workflow updates documenting triggers and expected runtime.
- RUNBOOK appendix guiding operators on running smoke tests manually.

## Phase 2 Architecture & Contracts
### Configuration Schema Updates
- **New env vars**
  - `BITCOIN_ZMQ_BLOCK` (optional): URI string pointing to Core's raw block stream (`tcp://host:port` or `ipc://path`).
  - `BITCOIN_ZMQ_TX` (optional): URI string for raw transaction notifications.
  - `LOG_LEVEL` (optional): enum `trace|debug|info|warn|error|fatal`; defaults to `info`.
  - `LOG_PRETTY` (optional): boolean-like string (`true`/`false`) controlling dev-friendly formatting.
  - `FEATURE_MEMPOOL_DASHBOARD` (optional): boolean string enabling/disabling the route (defaults to `true`).
- **Validation rules** (to be enforced via `zod` in `config.js`):
  - ZMQ URIs must pass regex `^(tcp|ipc)://`.
  - At least one of cookie or username/password still required; new vars must not weaken existing auth constraints.
  - Boolean-like vars parsed with `z.coerce.boolean()`.
- **Runtime defaults**:
  - If only one ZMQ endpoint set, listener subscribes to that topic only.
  - If dashboard disabled, route registration skipped and caches never populated.
- **Docs impact**:
  - README/RUNBOOK to include new variable explanations and sample `.env` entry.

### Module Boundaries & Interfaces
- **ZMQ Listener (`src/infra/zmqListener.js`)**
  - Exports `startZmqListener(config, emitter)` returning async stop handle.
  - Accepts config with optional block/tx endpoints; internally spawns subscriber sockets per topic.
  - Emits normalized events via provided emitter: `{ type: 'block:new', hash, raw }`, `{ type: 'tx:new', txid, raw }`.
  - Handles reconnect/backoff and logs via shared logger.

- **Cache Events Bus (`src/infra/cacheEvents.js`)**
  - Simple pub/sub with methods `subscribe(event, handler)` and `emit(event, payload)`.
  - Backed by `EventEmitter` but wrapped to allow injection/mocking.
  - Core caches register handlers (`blockCache.invalidate(hash)`, etc.).

- **Logging (`src/infra/logger.js`)**
  - Factory returning configured `pino` instance.
  - Middleware helper `requestLogger()` attaches ids and logs start/stop.
  - RPC wrapper obtains child logger with `context: { rpc: { method } }` for consistent structure.

- **Mempool Service (`src/services/mempoolService.js`)**
  - Functions: `getMempoolSnapshot({ page })`, `buildFeeHistogram(snapshot)`, `listRecentTransactions(snapshot, page)`. Returns view model consumed by controller.
  - Internally uses new `mempoolCache` with TTL + invalidation from event bus.

- **Routes / Controllers**
  - `src/routes/mempool.js` registers `/mempool` route when feature flag true.
  - Controller obtains data from service, passes to `views/mempool.njk` template.

- **Regtest Harness (`scripts/regtest/runner.js`)**
  - Provides async functions `startCore()`, `stopCore()`, `waitForCore()`, `mineBlocks(count)`.
  - Tests import harness to orchestrate scenarios.

- **Shared Types**
  - Create `src/types/logger.d.ts` (or JSDoc typedef) for log context to keep structured logging consistent.

### API & Data Contracts
- **Mempool Route (`GET /mempool`)**
  - Query params: `page` (optional, positive integer, defaults to 1).
  - Response (server-rendered) backed by view model:
    ```json
    {
      "snapshot": {
        "updatedAt": "2024-11-05T12:34:56.000Z",
        "txCount": 12500,
        "virtualSize": 8345123,
        "medianFee": 24.5,
        "histogram": [
          { "range": "1-5", "count": 1023, "vsize": 51234 },
          { "range": "6-10", "count": 2345, "vsize": 145678 },
          ...
        ],
        "recent": [
          {
            "txid": "…",
            "feerate": 18.2,
            "vsize": 192,
            "ageSeconds": 42,
            "isRbf": true
          }
        ]
      },
      "pagination": {
        "page": 1,
        "pageSize": 25,
        "totalPages": 80
      }
    }
    ```
  - Template consumes `snapshot`/`pagination`; ensure null-safe rendering when data unavailable.

- **Cache Invalidation Events**
  - Event names: `block:new`, `tx:new`.
  - Payloads:
    - `block:new`: `{ hash: string, height?: number, raw?: Buffer }`
    - `tx:new`: `{ txid: string, raw?: Buffer }`
  - Consumers must treat `raw` as optional (depends on decode success).

- **Structured Logs**
  - Emit top-level fields `timestamp`, `level`, `msg`, `context`.
  - Required context keys by area:
    - HTTP request finished: `{ requestId, route, method, status, durationMs, cache: { event, name? } }`
    - RPC call: `{ requestId?, rpc: { method, durationMs, errorCode? } }`
    - ZMQ event: `{ zmq: { topic, bytes }, event: 'subscribe'|'message'|'error' }`

- **Regtest Harness API**
  - Exported functions return Promises and throw typed errors with `code` property for easier retries.

### Documentation Touchpoints
- README: add table for new env vars and link to `/mempool` route description.
- RUNBOOK: include ZMQ configuration example, logging pipeline instructions, regtest smoke test appendix reference.
- CHANGELOG (future): entry summarising feature bundle upon release.

## Phase 3 Implementation Workplan

### 1. Structured Logging Foundation
**Tasks**
- Add `pino` dependency and create `src/infra/logger.js` factory with configuration derived from env vars.
- Implement Express middleware (`src/middleware/requestLogger.js`) that generates UUID, logs request start/end, and attaches logger instance to `req`/`res.locals`.
- Update RPC client (`src/rpc.js`) to log method duration and errors via shared logger.
- Wire logger into existing error handler to include `requestId` and structured metadata.
- Provide CLI flag/env to enable pretty printing in development.

**Tests**
- Unit test middleware to confirm UUID generation and log structure (mock pino transport).
- Integration test using Supertest to ensure logs emitted for sample request (capture stream).

**Acceptance Criteria**
- Every HTTP request produces start/finish log entries with consistent schema.
- RPC failures emit `error` logs including method, duration, and status code.
- Logger respects `LOG_LEVEL` and `LOG_PRETTY` env vars.

### 2. ZMQ Listener & Cache Busting
**Tasks**
- Introduce `zeromq` dependency and implement `startZmqListener` per module spec.
- Extend cache module to expose invalidation helpers and register handlers with event bus.
- Parse `rawblock`/`rawtx` payloads to derive hashes/txids; fallback to RPC on decode failure with structured warning log.
- Implement coalescing/throttling (e.g., debounce 100ms per cache key) to avoid floods.
- Add health hook to expose listener status (e.g., `GET /healthz` includes ZMQ state) if feasible.

**Tests**
- Unit tests for payload parsing utilities (raw bytes → hash/txid).
- Integration test stubbing event bus to confirm invalidation triggers on emitted events.
- Fault-injection test to simulate socket disconnect and verify reconnection/backoff with logs.

**Acceptance Criteria**
- When ZMQ enabled, new block/tx notifications clear relevant caches within <1s without crashing on disconnects.
- When ZMQ disabled, application functions using TTL only (no errors logged on startup).
- Listener emits structured logs for connect, message, error events.

### 3. Mempool Dashboard Delivery
**Tasks**
- Create `mempoolService` to fetch and aggregate mempool data (fee histogram, recent tx list).
- Add dedicated cache (`createCache`) for mempool snapshot with short TTL and event bus invalidation.
- Build `/mempool` route/controller + Nunjucks template with responsive layout and pagination.
- Hook route registration behind `FEATURE_MEMPOOL_DASHBOARD` flag.
- Update navigation/header to link to new dashboard.

**Tests**
- Service unit tests mocking RPC responses to validate aggregation logic and histogram output.
- Integration tests using Supertest to render page and assert key sections present.
- Accessibility smoke test (e.g., axe-core in Vitest) if feasible.

**Acceptance Criteria**
- `/mempool` renders within acceptable latency with real-time stats.
- Pagination and histogram behave correctly with mocked datasets.
- Feature flag disables route cleanly (404 or hidden link).

### 4. Regtest Smoke Tests Automation
**Tasks**
- Build `scripts/regtest` utilities for container lifecycle and RPC helpers.
- Write Vitest/Supertest suite that exercises block/tx flow against running regtest node.
- Integrate new npm script (`npm run test:regtest`) and optional CI job referencing regtest workflow.
- Ensure structured logs captured during test run for validation.

**Tests**
- Manual dry run locally to confirm script provisions regtest and tears down cleanly.
- CI dry run (on feature branch) to verify job duration and stability.

**Acceptance Criteria**
- Automated regtest suite passes consistently (<5 min runtime) and fails fast on regressions.
- CI workflow uploads artifacts on failure for diagnosis.
- Documentation updated to guide developers/operators on running smoke tests.
