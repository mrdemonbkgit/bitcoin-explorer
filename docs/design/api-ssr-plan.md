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

#### Endpoint Catalogue (Draft)
| Endpoint | Description | Query Params | Response Snapshot |
|----------|-------------|--------------|-------------------|
| `GET /api/v1/tip` | Chain tip summary | None | `{ "data": { "chain": "main", "height": 800000, "bestHash": "...", "mempool": {"txCount":123, "bytes":456789}, "feeEstimates": {"1": 12.3, "3": 8.1, "6": 5.4 } }, "meta": { "generatedAt": ISODateString } }` |
| `GET /api/v1/block/:id` | Block details by height/hash | `page` (optional, default `1`) | `{ "data": { "hash": "...", "height": 123, "time": 1700000000, "size": 123456, "weight": 400000, "version": 4, "bits": "1d00ffff", "difficulty": 55.1, "previousBlockHash": "...", "nextBlockHash": "...", "txCount": 2154, "txids": ["..."], "pagination": {"page":1,"totalPages":87,"pageSize":25} }, "meta": { } }` |
| `GET /api/v1/tx/:txid` | Transaction details (addresses, totals, RBF hint) | None | `{ "data": { "txid": "...", "hash": "...", "size": 250, "weight": 1000, "locktime": 0, "vin": [...], "vout": [...], "inputValue": 1.5, "outputValue": 1.499, "fee": 0.001, "isRbf": false }, "meta": {} }` |
| `GET /api/v1/mempool` | Mempool snapshot | `page` (optional, default `1`) | `{ "data": { "updatedAt": ISODateString, "txCount": 12000, "virtualSize": 8_500_000, "medianFee": 25.3, "histogram": [{"range":"1-5","count":123,"vsize":4567}, ...], "recent": [{"txid":"...","feerate":12.5,"vsize":200,"ageSeconds":34,"isRbf":false}] }, "meta": { "pagination": {"page":1,"pageSize":25,"totalPages":480} } }` |

##### Envelope & Error Shape
- Success: `{ "data": <payload>, "meta": <optional metadata> }`.
- Errors: `{ "error": { "code": <http status>, "type": <AppError name>, "message": <string> }, "meta": {} }`.
- Content negotiation: default to JSON; respond with `406` if `Accept` header excludes JSON.

##### TODOs for Phase 1
- Confirm whether block endpoint should return transactions inline or just txids/pagination (align with current HTML behaviour).
- Determine if mempool histogram requires additional metadata (e.g. bucket boundaries).
- Decide if we expose raw timestamps or formatted strings; proposal: API returns raw Unix timestamps/ISO strings, HTML performs formatting.

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
- ✅ `docs/API.md` captures endpoints, sample responses, and error formats.
- ✅ README + Runbook now reference the JSON API and health checks.
- ✅ `docs/TESTING.md` includes API coverage steps.

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
- `docs/PRD.md` Section 15 — Roadmap links and stakeholder expectations.
- `docs/TESTING.md` — Will be updated with API verification steps during implementation.
