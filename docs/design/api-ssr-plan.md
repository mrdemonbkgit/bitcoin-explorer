# API + SSR Split — Implementation Plan

## Goals
- Expose JSON APIs for core resources (tip, block, transaction, mempool) while preserving existing server-rendered views.
- Centralise business logic in shared services so both API and HTML layers reuse the same data contracts.
- Lay the foundation for future clients (CLI, SPA, metrics exporter) without breaking the LAN-first deployment model.

## Scope
### In Scope
- Introduce `/api/v1` endpoints mirroring current HTML pages.
- Refactor services to return plain data models consumable by both controllers.
- Add routing separation (UI router vs API router) with shared middleware (logging, error handling).
- Provide minimal request validation/query parsing for API endpoints.
- Update tests (unit + integration) to cover both output formats.
- Document endpoints, testing instructions, and operational considerations.

### Out of Scope (for this milestone)
- Breaking the HTML view layer into an SPA or client rendering.
- Authentication/authorization changes for API consumers.
- WebSocket/SSE notification channels (tracked separately).
- Versioned API negotiation beyond `/api/v1` prefix.

## High-Level Architecture
```
┌──────────┐      HTTP      ┌──────────────┐      Services      ┌─────────────┐
│ Clients  │ ─────────────> │ Express App  │ ────────────────> │ Data models │
└──────────┘                │  UI Router   │                   └─────────────┘
                            │  API Router  │
                            └──────────────┘
```
- `src/routes/ui/*.js` handle HTML responses (existing behaviour).
- `src/routes/api/*.js` respond with JSON; they re-use services for data fetching.
- Shared middleware (logging, error handling) remains in `src/middleware`.

## Work Breakdown
### Phase 1 — Discovery & Contracts
- Document target endpoints and response schemas (e.g. `/api/v1/tip`, `/api/v1/block/:id`, `/api/v1/tx/:txid`, `/api/v1/mempool`).
- Identify required query params and default behaviours (pagination, error mapping).
- Decide on response envelope (e.g. `{ data, meta }`).
- Update `docs/design/near-term-phase1.md` references if needed; produce schema snippets in this doc.

### Phase 2 — Service Refactor
- Audit existing services to ensure they return pure data objects.
  - Extract view-specific formatting (e.g. date strings) into adapters so API gets raw data, HTML can decorate.
- Introduce helpers for pagination metadata shared between API and UI.
- Maintain backwards compatibility for Nunjucks templates.

### Phase 3 — Routing & Controllers
- Create `src/routes/api/index.js` with individual modules per resource.
- Wire router in `src/server.js` under `/api/v1` with JSON-only middleware (`res.json` helpers, 406 for unsupported content types if necessary).
- Ensure structured logging includes `context.api: true` for API requests.
- Update error handler to emit JSON payloads for API requests while keeping HTML rendering for UI.

### Phase 4 — Testing
- Unit tests for API controllers using Supertest; validate response body, status codes, error conditions.
- Update existing integration tests to ensure UI still renders (no regressions).
- Add new tests ensuring shared services behave identically for API and UI (e.g. snapshot comparisons).
- Extend `npm run test` and `npm run coverage` coverage expectations; add API cases to `docs/TESTING.md`.

### Phase 5 — Documentation & DX
- Author `docs/API.md` (or README section) listing endpoints, sample requests/responses, and status codes.
- Update README/Runbook with API information and headers guidance.
- Mention in `docs/EXPANSION.md` that API split milestone is underway; adjust milestone timelines.

### Phase 6 — Rollout
- Smoke test locally (curl/Postman) hitting all endpoints.
- Update regtest smoke script to optionally verify API responses (future enhancement, optional for this milestone).
- Communicate change in changelog; consider feature flag (if necessary) for enabling API.

## Testing Strategy
- **Unit:** Vitest for new API controllers; mock services.
- **Integration:** Supertest hitting both `/` and `/api/v1/...` to ensure data parity.
- **Regression:** `npm run test` and `npm run ci` must remain green.
- **Manual:** Follow `docs/TESTING.md` updates—use curl to confirm endpoints.

## Risks & Mitigations
- **Data divergence:** If services start returning view-specific data, API/HTML might drift. Mitigate with shared adapters and tests comparing outputs.
- **Error format mismatch:** Ensure consistent mapping of `AppError` subclasses to HTTP statuses in both layers.
- **Backward compatibility:** Keep existing URLs unchanged; publish API as additive feature.

## Timeline (estimates)
- Week 1: Contracts + service refactor.
- Week 2: API router/controllers + logging adjustments.
- Week 3: Testing, documentation, validation, polish.

## References
- `docs/EXPANSION.md` — Mid-term workstream alignment.
- `docs/TESTING.md` — Will be updated with API verification steps during implementation.
