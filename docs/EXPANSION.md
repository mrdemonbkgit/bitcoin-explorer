# Expansion Roadmap — Slim Bitcoin Explorer

## Purpose
This document captures ambitious growth directions for the explorer so we can plan beyond the current LAN-first MVP. It aligns each idea with the existing PRD principles (simplicity, local control, observability) while acknowledging the new complexity we are willing to embrace.

## Guiding Principles
- Keep Bitcoin Core as the source of truth; any derived data should be reproducible and sidecar-friendly.
- Preserve operator control: LAN-first deployments, minimal hidden dependencies, and opt-in complexity.
- Favour incremental milestones so large features can be validated in isolation.
- Maintain observability and test coverage as complexity increases (lint/typecheck/test/build must stay green).

## Workstreams & Ideas

### 1. Feature Surfaces
- **Address & Xpub Views**: allow lookup of UTXOs, balances, and transaction history; requires lightweight indexing layer or batched RPC aggregation.
- **Mempool Intelligence**: dedicated page with live fee histograms, inbound tx stream, and pinning of interesting transactions.
- **Fee & Chain Analytics**: charts for confirmation time, fee rate trends, difficulty and supply metrics.
- **Advanced Search**: fuzzy/partial-matching, entity tagging, and contextual search results (confirmations, related blocks/tx).

### 2. Architecture & Services
- **API + SSR Split**: expose a JSON API consumed by both the server-rendered views and future clients; enforce typed contracts.
- **Realtime Layer**: integrate ZMQ or WebSockets for block/tx notifications and cache invalidation.
- **Background Schedulers**: pre-warm caches, detect reorgs, emit alerts, and manage derived datasets without blocking HTTP handlers.
- **Plugin System**: a module loader that lets operators drop in bespoke features (e.g., Lightning channel explorer) without patching core code.

### 3. Data & Storage Strategy
- **Local Indexing**: embed LevelDB/SQLite/Badger to persist address graphs, fee buckets, or historical snapshots while keeping Core authoritative.
- **Historical Aggregations**: maintain rolling statistics (mempool depth, chain tip velocity) with TTL rules to prevent unbounded growth.
- **Data Lifecycle**: design backup, pruning, and migration flows for any persisted artifacts.

### 4. Operations & Observability
- **Metrics & Tracing**: ship OpenTelemetry spans, structured logs, and Prometheus-compatible metrics (RPC latency, cache hit ratio, render time).
- **Health & Diagnostics**: dedicated status endpoint, configuration dump (redacting secrets), and self-check routines.
- **Deployment Profiles**: container images, IaC templates, and scripted provisioning for dev/staging/prod with smoke tests in CI/regtest.
- **Multi-Core Awareness**: support failover or load balancing across archival/pruned nodes with heartbeat checks.

### 5. Security & Access Control
- **Role-Based Access**: operator and read-only roles, LAN allowlists, API keys, or mutual TLS for advanced endpoints.
- **Audit Trails**: log search/activity footprints and provide hooks for SIEM ingestion.
- **Policy Engines**: configurable rules to flag transactions (RBF, high feerate, OP_RETURN) and raise alerts via webhooks/email.

### 6. UX & Frontend Evolution
- **Interactive UI**: progressively enhance SSR views (client-side hydration, collapsible sections, drill-down modals).
- **Customization**: theming, dashboard widgets, operator branding, saved queries.
- **Accessibility**: ensure responsive layouts, keyboard navigation, and color-safe palettes as complexity grows.

## Milestone Sketch
- **Near-Term (Quarter 1)** ✅ Completed — ZMQ cache busting, mempool dashboard, structured logging, and CI smoke tests are live.
- **Mid-Term (Quarter 2)** ▶ In progress — API surface (see `docs/design/api-ssr-plan.md`), address/xpub explorer with local index, WebSocket notifications, metrics exporter; coordinate scope with `docs/PRD.md` Section 15 and keep `docs/RUNBOOK.md`/`docs/TESTING.md` updated as milestones land.
- **Long-Term (Quarter 3+)**: pluggable modules, analytics warehouse, multi-node awareness, optional authZ/authN stack.

### Near-Term Bundle Implementation Plan
> Detailed Phase 1 discovery notes live in `docs/design/near-term-phase1.md`.

#### Goals
- Deliver real-time freshness via ZMQ-driven cache busting, enriched UX with a mempool dashboard, structured logs for diagnostics, and regtest-based smoke tests without compromising LAN-first simplicity.
- Success metrics: sub-second cache invalidation after new blocks/tx, mempool dashboard hit latency under 1s when warm, structured logs consumable by journald/ELK, and reproducible regtest job in CI.

#### Phase 1 – Discovery & Design
1. ZMQ Integration: review Core topics (`rawblock`, `rawtx`), auth/network requirements, and environment settings (e.g., `BITCOIN_ZMQ_BLOCK`, `BITCOIN_ZMQ_TX`).
2. Cache Strategy: map caches to invalidate (`tip`, `block`, `tx`), design fallback to TTL-only mode, and define internal event bus interface.
3. Mempool Dashboard UX: wireframe layout (fee histogram, inbound tx table, aggregate stats), define data sources (`getmempoolinfo`, `getrawmempool true`), and caching behaviour.
4. Structured Logging: select JSON lines format, required fields (timestamp, level, route, request id, RPC latency), and assess logger library vs custom serializer.
5. Regtest Smoke Tests: choose tooling (Docker `bitcoind`, regtest binaries), outline scenarios (mine block, broadcast tx, verify dashboard update), and note CI resource requirements.

#### Phase 2 – Architecture & Contracts
- Extend config schema with ZMQ endpoints, logging level, and regtest toggles; document validation rules.
- Define module boundaries: ZMQ listener, cache invalidation service, mempool service extensions, logging wrapper, regtest harness.
- Plan API contracts (mempool route payload, logging metadata, optional health probe enhancements).
- Draft documentation updates for README/RUNBOOK covering new configuration and operations.

#### Phase 3 – Implementation Sequence
1. Structured Logging Foundation: introduce logger wrapper, emit consistent fields for HTTP and RPC events, add unit tests, and document format.
2. ZMQ Listener & Cache Busting: implement subscriber loop with reconnect/backoff, hook cache invalidation, maintain TTL fallback, and create integration tests with mocked ZMQ events.
3. Mempool Dashboard: build service functions for mempool stats, add route/view with caching tied to ZMQ invalidation, and cover with Vitest integration tests (accessibility checks included).
4. Regtest Smoke Tests: script regtest network setup, mine/broadcast during tests, integrate Supertest assertions, add CI workflow job (nightly/on-demand), and document troubleshooting.

#### Phase 4 – Validation & Rollout
- Execute `npm run ci` plus regtest workflow locally; measure runtime impact.
- Manual QA against live node verifying dashboard updates and log outputs.
- Update README, RUNBOOK, and CHANGELOG with new features/config keys.
- Hold cross-functional review (Product, Dev, QA, DevOps, Docs) to confirm acceptance criteria.

#### Risks & Mitigations
- ZMQ unavailable: keep feature optional with graceful degradation.
- Resource spikes: summarize mempool data and rate-limit updates.
- CI duration: gate regtest job (nightly or opt-in).
- Logging noise: expose log level/sampling config.

#### Deliverables & Timeline
- Updated services (logging, cache, mempool) with tests, new mempool route/view, regtest scripts + CI job, documentation updates.
- Target timeline (approx.): Week 1 discovery/logging, Week 2 ZMQ, Week 3 dashboard, Week 4 regtest + rollout.

## Coordination
- **Product**: prioritize feature surfaces based on operator feedback; refine PRD accordingly.
- **Development**: spike architectural changes (API split, background jobs) and maintain lint/typecheck/test rigor.
- **QA**: extend Vitest + integration coverage, add regtest suites, monitor coverage thresholds.
- **DevOps**: evolve CI/CD to include container builds, audits, and deployment automation; keep runbooks current.
- **Documentation**: update README/RUNBOOK/PRD when milestones land; maintain onboarding notes for new contributors.

Revisit this roadmap after each milestone to confirm priorities and capture new insights.
