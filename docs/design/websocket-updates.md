# WebSocket Notifications — Design & Implementation Plan

## Task Tracker
- [ ] Development — (Dev)
  - [ ] Add configuration flags (`WEBSOCKET_ENABLED`, `WEBSOCKET_PATH`, `WEBSOCKET_PORT`) with zod validation and sensible defaults.
  - [ ] Introduce a WebSocket gateway that subscribes to cache/ZMQ events and pushes tip, block, tx, and mempool updates to connected clients.
  - [ ] Update Nunjucks views (home, mempool) with optional client-side hydration to consume WebSocket payloads without breaking SSR.
  - [ ] Integrate metrics/logging for WS connections, broadcasts, and errors.
- [ ] Quality Assurance — (QA)
  - [ ] Extend unit/integration tests covering gateway behaviour, disabled mode (404/upgrade rejection), and client payload shape.
  - [ ] Add optional regtest smoke toggle (`REGTEST_WS_CHECK=true`) to validate realtime updates end-to-end.
- [ ] DevOps — (DevOps)
  - [ ] Document deployment guidance (LAN-only binding, reverse proxy considerations) in RUNBOOK and sample Prometheus metrics additions (if scraped).
  - [ ] Ensure CI runs `npm run lint`, `npm run typecheck`, and WS-specific tests and keep coverage thresholds green.
- [ ] Documentation — (Docs)
  - [ ] Update README/TESTING with WebSocket enablement instructions and fallback behaviour.
  - [ ] Announce the feature in CHANGELOG once merged.

## Overview
We will add an optional WebSocket channel that pushes near-real-time updates (tip height/hash, new transactions, mempool changes) to LAN clients. The channel piggybacks on existing ZMQ cache invalidation so connected browsers receive updates instantly, while SSR pages remain functional without WebSocket support.

## Goals
- Deliver sub-second updates for the home dashboard and mempool page without aggressive polling.
- Keep the feature optional and safe: default disabled, LAN-only, minimal resource usage.
- Ensure parity between API/SSR data and WebSocket payloads to avoid divergence.

## Non-Goals
- Authentication/authorization for the WebSocket endpoint (rely on LAN trust/firewall).
- Replacing SSR with a full SPA—client scripts remain progressive enhancements.
- Persisting WebSocket sessions or message history.

## Requirements
- **Configuration**: introduce env vars
  - `WEBSOCKET_ENABLED` (default `false`)
  - `WEBSOCKET_PATH` (default `/ws` or `/socket`)
  - `WEBSOCKET_PORT` (optional; default reuse HTTP server)
- **Payloads**: define message types (`tip.update`, `mempool.update`, `block.mined`, `tx.seen`). Use JSON with consistent schema (e.g., `{ type, data, timestamp }`).
- **Clients**: Provide lightweight JS snippet injected into relevant Nunjucks templates when enabled; include reconnect/backoff handling.
- **Backpressure**: Ensure broadcast queue is bounded; drop or throttle if clients fall behind.
- **Observability**: integrate with existing logger/metrics pipeline (connection counts, broadcasts, errors).

## Architecture
```
┌─────────────┐      HTTP      ┌───────────────────┐          ┌───────────────┐
│ Browsers    │ ─────────────> │ Express (SSR/API) │          │ Cache Events  │
│ (LAN)       │                │                   │◀─────────┤ (tip/block/tx)│
│  WebSocket  │◀──────────────▶│ WS Gateway        │──────────▶│ Broadcast Bus │
└─────────────┘  Upgrade       └───────────────────┘          └───────────────┘
```
- Reuse `startZmqListener` to emit cache events; WS gateway subscribes to the same emitter.
- When enabled, attach a WebSocket server (likely via `ws` library) sharing the Express HTTP server or an optional dedicated port.
- Broadcast messages to connected clients after each cache invalidation; include minimal payload to avoid heavy serialization.
- Add client-side script on pages that benefit (home, mempool) to listen for updates and trigger DOM refresh (e.g., via API fetch or inline rendering).

## Implementation Plan
1. **Config & Setup** (`Dev`)
   - Update `src/config.js` with new WebSocket env vars using the Boolean parsing helpers already in place.
   - Document defaults in `docs/env.sample` and README.
2. **Gateway Module** (`Dev`)
   - Add `src/infra/websocketGateway.js` responsible for creating the WebSocket server, managing connections, broadcasting events, and graceful shutdown.
   - Hook into `CacheEvents` (`CacheEvents.BLOCK_NEW`, `CacheEvents.TX_NEW`) and additional internal events for mempool snapshots.
3. **Server Integration** (`Dev`)
   - Modify `src/server.js` to start the gateway when `config.websocket.enabled` is true; ensure shutdown closes sockets.
   - Emit startup logs akin to metrics (`websocket.enabled`).
4. **Client Enhancements** (`Dev`)
   - Inject a small JS bundle (vanilla) into relevant Nunjucks templates when feature flag is on.
   - On receiving events, either update DOM directly for small payloads or trigger fetch to existing API endpoints for full data.
5. **Instrumentation** (`Dev`)
   - Extend metrics to capture connections, broadcasts, dropped messages (new counters/histograms under `explorer_websocket_*`).
   - Add structured logs (`websocket.connection`, `websocket.error`, etc.) using `getLogger()` scope.
6. **Testing** (`QA`)
   - Unit tests for gateway event handling (mock cache events → broadcast).
   - Integration tests using a WebSocket client (e.g., `ws`) to assert connections succeed when enabled and are refused when disabled.
   - Update regtest smoke to optionally run with `REGTEST_WS_CHECK=true`, connecting a WS client and verifying at least one update is received after mining/broadcasting.
7. **Documentation** (`Docs`/`DevOps`)
   - README/RUNBOOK/TESTING updates covering flags, sample usage, and security considerations (LAN-only, firewall).
   - CHANGELOG entry once the feature ships.

## Testing Strategy
- **Unit**: Gateway logic (connection lifecycle, broadcast queue) with mocked sockets.
- **Integration**: End-to-end test starting Express app with WS enabled; connect via `ws` client, simulate cache events, assert payload.
- **Regtest**: Optional job verifying real traffic triggers WS messages (behind env toggle to keep default fast).
- **Manual**: Start explorer with WS enabled, open home/mempool in browser, observe real-time updates and console logs.

## Operational Considerations
- Default disabled; operators enable via `.env`. Keep binding to primary server to minimize ports unless override requested.
- Document firewall guidance—if exposing beyond LAN, reverse proxy with authentication is required (out of scope for MVP).
- Monitor metrics/logs for connection proliferation; consider connection limits to avoid resource exhaustion.

## Open Questions
- Should the client bundle fetch full data on each event (to reuse existing rendering) or receive precomputed payloads? Proposed: start with minimal payloads + API fetch to reduce gateway complexity.
- Do we need fallbacks for browsers without WS? Yes—SSR and periodic polling remain; the JS snippet should detect WS availability and fail silently.
- Should mempool updates stream incremental differences? MVP can send “invalidate” event prompting client refetch; diff-streaming can be future work.

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Resource usage spikes from many WS clients | Limit LAN scope, implement heartbeat/ping + idle timeout, and document expectations in RUNBOOK. |
| Payload divergence from SSR/API | Reuse existing services; send route identifiers and have clients refetch via APIs to maintain single source of truth. |
| Flaky WS in regtest/CI | Make WS smoke optional with env toggle; keep default workflow fast. |

## Timeline (Estimates)
- Week 1: Design finalization, config plumbing, gateway prototype.
- Week 2: Client enhancements, instrumentation, unit tests.
- Week 3: Integration/regtest testing, docs, rollout.

## Dependencies
- `ws` (or similar) library for WebSocket server/client.
- Existing `CacheEvents` emitter and services for consistent data payloads.

## References
- `docs/EXPANSION.md` Mid-term milestone (WebSocket notifications).
- `docs/PRD.md` Section 15 — roadmap alignment.
- `docs/design/metrics-exporter.md` for instrumentation patterns to mirror (metrics/logging).
