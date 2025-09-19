# Metrics Exporter — Design & Implementation Plan

## Task Tracker
- [x] Development — (Dev)
  - [x] Add metrics configuration (feature flag, bind settings) to `src/config.js` with zod validation.
  - [x] Integrate a metrics registry (e.g., `prom-client`) and expose counters/histograms for HTTP requests, RPC calls, cache hits/misses, and ZMQ events.
  - [x] Add `/metrics` HTTP endpoint secured to LAN/feature flag, emitting Prometheus text format.
  - [x] Instrument existing code paths (request logger, RPC client, cache layer, ZMQ listener) to update the new metrics.
- [x] Quality Assurance — (QA)
  - [x] Extend unit/integration tests to cover metrics endpoint success, disabled state, and basic sample assertions.
  - [x] Update regtest smoke (`scripts/regtest/smoke.js`) to optionally scrape `/metrics` and validate key series.
- [x] DevOps — (DevOps)
  - [x] Document metrics configuration in RUNBOOK (bind, auth guidance, scraping interval) and include Prometheus scrape sample.
  - [x] Update CI workflow to run `npm run lint`, `npm run typecheck`, and metrics-specific tests; confirm coverage thresholds stay green.
- [x] Documentation — (Docs)
  - [x] Update README and TESTING guides with metrics instructions and curl examples.
  - [x] Announce the feature in CHANGELOG once merged.

## Overview
We will extend the explorer with an optional metrics exporter so operators can collect runtime telemetry (RPC latency, cache hit ratio, HTTP throughput). The exporter will emit Prometheus-compatible text at `/metrics`, guarded by a feature flag and LAN-only binding to preserve the MVP security posture.

## Goals
- Visibility into cache efficiency, RPC performance, HTTP request volumes, and ZMQ invalidation rates.
- Minimal runtime overhead; metrics collection must not impact request latency noticeably.
- Straightforward Prometheus integration (example scrape config) with no mandatory external services.

## Non-Goals
- Building a full metrics dashboard or alerting rules (deferred to operators).
- Embedding authentication/authorization for the metrics endpoint (document firewall guidance instead).
- Shipping an alternate metrics format (e.g., StatsD, OpenTelemetry exporter) in this iteration.

## Requirements
- **Configurability**: introduce env vars, e.g. `METRICS_ENABLED` (default `false`), `METRICS_PATH` (default `/metrics`), `METRICS_INCLUDE_DEFAULT` (default `false`).
- **Safety**: when disabled, the endpoint must return 404 and avoid initializing collectors.
- **Coverage**: collect at minimum
  - HTTP request counter + duration histogram by route + status family.
  - RPC call counter + duration histogram + error counter.
  - Cache hit/miss counts for tip/block/tx/mempool caches.
  - ZMQ events counter (block/tx notifications received, queue overflow).
- **Performance**: instrumentation must occur in hot paths that already allocate context (request logger, RPC wrapper, cache); avoid heavy allocations.
- **Docs & Testing**: update RUNBOOK, TESTING, README, CHANGELOG; add automated tests.

## Architecture
```
┌────────────┐        ┌────────────────────┐        ┌──────────────────┐
│ Prometheus │◀──────▶│ Explorer /metrics  │◀──────▶│ Metrics Registry │
└────────────┘ scrape │  (feature-flagged) │  pull   └──────────────────┘
                              ▲                           ▲
            HTTP middleware ──┘                           │
            RPC wrapper ──────────────────────────────────┤
            Cache layer ──────────────────────────────────┤
            ZMQ listener ─────────────────────────────────┘
```
- Use `prom-client` Registry per process. Attach default Node.js process metrics behind a flag (optional `METRICS_INCLUDE_DEFAULT=true`).
- Register middleware to increment request metrics; integrate with `requestLogger` for shared context.
- Wrap `rpcCall` to record duration and errors.
- Extend cache implementation to emit hit/miss counters (without hard dependency on Prometheus by injecting recorder fns).
- ZMQ listener increments counters when receiving messages or encountering errors.

## Implementation Plan
1. **Config & Feature Flag** (`Dev`)
   - Update `src/config.js` to parse new env vars with defaults.
   - Provide `config.metrics.enabled`, `config.metrics.path`, `config.metrics.includeDefault`, `config.metrics.port` (optional separate bind, default reuse main server).
2. **Metrics Module** (`Dev`)
   - Create `src/infra/metrics.js` exporting `createMetricsRegistry(config)` that returns collectors and an Express handler.
   - Define metric names (e.g., `explorer_http_requests_total`, `explorer_http_request_duration_seconds`, `explorer_rpc_requests_total`, `explorer_rpc_request_duration_seconds`, `explorer_cache_events_total`, `explorer_zmq_events_total`).
   - Use buckets tuned for sub-second latency (e.g., `[0.05, 0.1, 0.25, 0.5, 1, 2, 5]`).
3. **Integration Points** (`Dev`)
   - Update `requestLogger` or new middleware to increment HTTP metrics per request outcome.
   - Wrap `rpc.js` to measure durations and errors.
   - Modify `cache.js` to accept a metrics recorder; default to no-op when disabled.
   - Extend `infra/zmqListener.js` to bump counters for subscribe message/error events.
4. **Endpoint Wiring** (`Dev`/`DevOps`)
   - Mount Express route at configured path when metrics enabled; respond with `text/plain; version=0.0.4` Prometheus format using registry `metrics()`.
   - Include startup log showing metrics availability (bind + path).
5. **Testing** (`QA`)
   - Unit tests for metrics module (ensuring registration, disabled mode returns 404, histograms increment).
   - Integration test hitting `/metrics` verifying sample output contains expected series names.
   - Update regtest smoke optional path to scrape metrics after activity (guard with env to avoid default runtime cost).
6. **Docs & Ops** (`Docs`/`DevOps`)
   - README quickstart snippet (enable via `.env`, sample curl).
   - RUNBOOK additions for enabling metrics, recommended Prometheus scrape config, security notes (LAN-only, firewall).
   - TESTING guide section for metrics verification.
   - CHANGELOG entry once shipped.

## Testing Strategy
- **Unit**: metrics module, config validation, cache instrumentation with mocked recorder.
- **Integration**: Express app with metrics enabled; assert text exposition fields; ensure disabled mode returns 404.
- **Regtest (optional)**: extend smoke to fetch `/metrics` and verify counters increase after traffic (behind env toggle to avoid flakiness).
- **Manual**: `curl http://localhost:28765/metrics` and import sample into Prometheus; ensure values change after block/tx events.

## Operational Considerations
- Expose metrics via the main server/port by default to avoid extra processes; document firewall rules for operators.
- Provide guidance on running `METRICS_ENABLED=true` only on trusted networks.
- Recommend scrape interval (e.g., 15s) and emphasise predictable label sets (route template, status class).

## Open Questions
- Do we need a separate bind/port for metrics? Default to shared port but consider optional override.
- Should we expose Node.js process metrics by default? Proposed default `false` to avoid leaking host internals.
- Any need for auth tokens? For MVP, rely on LAN trust + firewall.

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Cardinality explosion from dynamic routes | Normalise label values using route templates and status classes only. |
| Performance overhead of histograms | Use sparse bucket sets and sampling hooks already used for logging to avoid duplicate work. |
| Metrics endpoint leaking sensitive info | Limit output to aggregate counters/timers; document LAN-only exposure and optional firewall controls. |

## Timeline (Estimates)
- Week 1: Config + metrics module prototyping.
- Week 2: Instrument HTTP/RPC/cache/ZMQ paths; add tests.
- Week 3: Documentation updates, optional regtest scrape, rollout.

## Dependencies
- `prom-client` (or similar) runtime dependency.
- Existing logging/caching infrastructure for instrumentation touchpoints.

## References
- `docs/EXPANSION.md` — Mid-term milestone (metrics exporter).
- `docs/PRD.md` Section 15 — Roadmap alignment.
- `docs/TESTING.md`, `docs/RUNBOOK.md` — to be updated during implementation.
