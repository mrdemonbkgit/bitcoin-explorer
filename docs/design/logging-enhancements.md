# Structured Logging Enhancements — Design Plan

## Task Tracker
- [x] Development — (Dev)
  - [x] Extend logging configuration to support destination selection, field redaction, and sampling.
  - [x] Update request/response instrumentation with richer context (latency, payload hints, cache/API markers).
  - [x] Add subsystem-specific log scopes for ZMQ, WebSocket, and the address indexer with consistent context.
- [ ] Quality Assurance — (QA)
  - [ ] Add unit/integration tests validating log serializers, redaction, and structured payload coverage.
  - [ ] Exercise log assertions in regtest smoke to confirm events emit during block/tx flows.
- [ ] DevOps — (DevOps)
  - [ ] Document log destinations and rotation guidance; ensure CI/CD surfaces logs for debugging.
  - [ ] Validate compatibility with common supervisors (systemd, Docker) and update RUNBOOK with retrieval examples.
- [x] Documentation — (Docs)
  - [x] Update README/RUNBOOK/TESTING to reflect new logging options and verification steps.
  - [x] Summarise changes in CHANGELOG and reference this plan in WORKLOG entries.
- [ ] Product — (Product)
  - [ ] Confirm logging requirements align with LAN-only privacy expectations and stakeholder observability needs.

## Overview
Structured logging shipped in v0.2.0 via `pino`, but output currently streams only to stdout with limited context. Operators have asked for richer diagnostics (cache hit signals, WebSocket/ZMQ failures) and optional file targets without sacrificing the LAN-first simplicity. This plan codifies how to deepen logging while maintaining minimal dependencies.

## Goals
- Preserve machine-readable JSON logs while allowing optional pretty output for local debugging.
- Capture consistent request metadata (route template, status family, response bytes, cache hit/miss) and tie it to subsystem events via `requestId`.
- Provide optional destinations (stdout, rotating file, external transport hook) configurable at runtime.
- Support field redaction (RPC credentials, cookies) before emission.
- Surface structured logs for background components: address indexer sync/rollback, ZMQ reconnects, WebSocket lifecycle.
- Maintain alignment with Prometheus metrics to ease correlation.

## Non-Goals
- Building a full log aggregation pipeline (e.g., shipping to Loki/ELK) — operators remain responsible for downstream collection.
- Introducing third-party logging SaaS SDKs or requiring network egress.
- Adding authentication/authorization layers to logs themselves (out of scope).

## Requirements
- **Configuration**: extend `src/config.js` to accept `LOG_DESTINATION` (`stdout`, `file`, `transport:<module>`), `LOG_REDACT` (JSON path list), and `LOG_SAMPLE_RATE` (0–1). Defaults preserve stdout-only behaviour.
- **Structure**: every log entry must include `timestamp`, `level`, `message`, `context.event`, and optional nested context (request, cache, rpc, websocket, addressIndexer, zmq).
- **Correlation**: propagate `requestId` through AsyncLocalStorage for HTTP routes, API handlers, and downstream services (cache, RPC, WebSocket broadcast triggered by request).
- **Subsystem Coverage**:
  - Address indexer: log sync start/progress/complete, reorg detection, checkpoint flush, crash recovery (`event` keys like `addressIndexer.sync.complete`).
  - ZMQ listener: log connect/disconnect, retry backoff, dropped notifications when queue is full.
  - WebSocket gateway: log connection open/close, broadcast counts, serialization errors.
- **Redaction**: sensitive fields (RPC auth, cookies) must be filtered automatically via `pino` redaction or custom serializer with tests.
- **Backpressure**: ensure file transport uses async buffering with configurable flush interval; failing transport must degrade gracefully and emit warning without crashing app.

## Architecture
```
┌──────────────┐    structured logs    ┌──────────────┐
│ HTTP layer   │ ────────────────────▶ │ pino logger  │ ──▶ stdout / file / transport
│ (Express)    │    requestId, cache   │ (configurable│
└──────────────┘                       │ destination) │
       │                                └──────────────┘
       ▼
┌──────────────┐ events (cache/RPC) ┌──────────────┐
│ Services     │───────────────────▶│ Logger child │
│ (tip, block, │                   │ per module   │
│ mempool, addr│                   └──────────────┘
└──────────────┘
       │
       ▼
┌──────────────┐                      ┌──────────────┐
│ Background   │   async events ────▶ │ Structured   │
│ (ZMQ, WS,    │                     │ logs + alerts │
│ indexer)     │                     └──────────────┘
└──────────────┘
```
- Centralise configuration in `logger.js`; instantiate `pino` with configured transport (stdout or file). For file outputs, use `pino/file` with daily rotation (size + age triggers) and expose health logs when rotation fails.
- Continue using AsyncLocalStorage for per-request context; extend helper to expose `withRequestContext()` for background tasks triggered within request scope (e.g., API-driven reindex).
- Provide `createModuleLogger('address-indexer')` helper returning a child logger with `module` binding.

## Implementation Plan
1. **Config plumbing**
   - Update `src/config.js` to parse new log settings with validation (file path must be writable, sample rate between 0 and 1).
   - Extend `.env` sample and RUNBOOK to describe usage.
2. **Logger factory**
   - Modify `src/infra/logger.js` to construct transports based on config, inject redaction arrays, and expose `withRequestLogger` utility returning both logger and teardown handle for manual scopes.
   - Implement sampling wrapper (`shouldLog(level)`) to drop low-level logs probabilistically when configured.
3. **HTTP middleware**
   - Enhance `src/middleware/requestLogger.js` to record route template (`req.route.path` or `req.baseUrl`), response size, referrer, user-agent, and a `isApi` flag.
   - Log cache result metadata by emitting `context.cache` from caches (update `src/cache.js`).
4. **Subsystem updates**
   - Address indexer (`src/infra/addressIndexer.js`): replace string logs with structured `logger.info({ context: { event: 'addressIndexer.sync.progress', ... } })`; add error logs for reorg rollback.
   - ZMQ listener (`src/infra/zmqListener.js`): log `subscribe`, `message`, `retry`, `overflow`, `close` events with metrics alignment.
   - WebSocket gateway (`src/infra/websocketGateway.js`): new log entries for connections, broadcasts, errors, ping timeouts.
5. **Redaction & testing**
   - Define redaction paths (e.g., `['context.rpc.auth', 'context.headers.cookie']`) and ensure tests confirm sensitive data is masked.
6. **Transport resilience**
   - On transport error (file not writable), fallback to stdout and emit warning once to avoid log storms.
7. **Docs & rollout**
   - Update README, RUNBOOK, TESTING with config guidance, log sampling notes, and verification steps.
   - Add CHANGELOG entry once merged.

## Testing Strategy
- **Unit**
  - Logger factory tests verifying transport selection, redaction, and sampling logic (`vitest` with `pino.transport` mocks).
  - Middleware test ensuring request logs include required fields and redacted data (use Supertest with captured transport).
- **Integration**
  - Build a test harness that spins up the app with in-memory transport capturing log entries; assert entries for HTTP hit, cache miss, RPC failure, ZMQ notification.
  - Extend regtest smoke (`scripts/regtest/smoke.js`) to optionally persist logs and check for `addressIndexer.sync.*` events during runs (behind env toggle to keep runs light).
- **Manual**
  - RUNBOOK checklist: enable file destination, tail log, trigger block/tx events, verify entries rotate and show redacted secrets.

## Rollout & Adoption
- Default behaviour: unchanged (stdout JSON). Operators opt-in to file logs via `.env` once validated.
- Provide migration guidance in WORKLOG when feature ships; highlight new env vars and recommended values.
- Monitor nightly CI/regtest for log integrity warnings; add alert if logger falls back from file to stdout unexpectedly.

## Open Questions
- Should we include optional request/response body sampling for APIs? (Risk: privacy vs debugging.)
- Do we need per-module sampling rates (e.g., verbose ZMQ vs critical errors)?
- Would bundling a log rotation dependency conflict with the “slim” vision, or should we rely on external supervisors for rotation?

## References
- `src/infra/logger.js` — current logger implementation.
- `src/middleware/requestLogger.js` — request lifecycle instrumentation baseline.
- `src/infra/addressIndexer.js` — target for detailed sync logs.
- `docs/TESTING.md` — to be updated with log verification steps.
