# Address/Xpub Explorer — Discovery & Design Plan

## Task Tracker
- [ ] Development — (Dev)
  - [ ] Evaluate storage options (LevelDB vs SQLite/Badger) for a lightweight address index; document chosen approach.
  - [ ] Implement indexer module ingesting transactions via RPC/ZMQ and persisting address→UTXO/tx mappings.
  - [ ] Add backend services and routes for address/xpub lookup with pagination and summary statistics.
  - [ ] Update Nunjucks views (address overview, transaction list) with SSR-first rendering.
- [ ] Quality Assurance — (QA)
  - [ ] Design unit/integration tests covering index updates, lookup correctness, and pagination edge cases.
  - [ ] Extend regtest smoke to seed addresses/xpubs and validate explorer output (optional CI toggle like `REGTEST_ADDRESS_CHECK`).
- [ ] DevOps — (DevOps)
  - [ ] Document storage footprint, retention, and backup guidance in RUNBOOK; highlight new env vars/config for indexer.
  - [ ] Ensure CI covers lint/typecheck/tests with the new indexer and address routes; monitor runtime impact.
- [ ] Documentation — (Docs)
  - [ ] Update README/TESTING with address explorer instructions and caveats (e.g., index build time, privacy notes).
  - [ ] Add changelog entry when feature ships; cross-reference PRD/roadmap.
- [ ] Product — (Product)
  - [ ] Confirm scope (address summary fields, xpub support, rate limits) with stakeholders; update PRD/requirements as needed.

## Background & Goals
- Provide LAN operators with address/xpub visibility using data derived from their own Bitcoin Core node.
- Keep Bitcoin Core the source of truth; the indexer should be reproducible, bounded in size, and avoid external dependencies.
- Maintain SSR-first UX consistent with existing pages; JSON API parity can follow.

## Non-Goals
- Full Chain analytics, batching, or external data sources beyond Core RPC/ZMQ.
- Address clustering, tagging, or heuristic analysis (future roadmap).
- Replacing the indexer with Core’s `txindex` (assume `txindex=1` is present, but we still build derived address maps).

## Requirements (Draft)
- Address page (`/address/:id`): show summary (balance, UTXO count, total received/sent), recent transactions with pagination, links to `/tx/:txid` and relevant blocks.
- Xpub page (`/xpub/:key`): support BIP32 key derivation limited to a configured gap limit (default 20); display derived addresses and balances.
- Indexer:
  - Seed by scanning `listtransactions`/`gettxoutsetinfo`? (Need to determine strategy.)
  - Keep data on-disk (LevelDB/SQLite) with TTL/compaction strategy.
  - Listen to ZMQ (`rawtx`, `rawblock`) to stay in sync; handle reorgs gracefully.
- Configuration:
  - Feature flag `FEATURE_ADDRESS_EXPLORER` default false.
  - Paths for index storage (`ADDRESS_INDEX_PATH`), gap limit for xpub, optional prune toggles.
- Performance Targets:
  - Initial index build should complete within reasonable time (document heuristics based on Core size).
  - Lookup latency < 500ms for cached addresses, < 2s for complex xpub scans.
- Security/Privacy:
  - Document implications of storing address data; advise restricting LAN access.
  - Provide cleanup script/env to disable and purge index.

## Open Questions
- Source of truth for historical data: use `getrawtransaction` + `decoderawtransaction` or rely on `scantxoutset`/`importmulti` flows?
- Should the indexer maintain transaction history (spent outputs) or just UTXO snapshots + references?
- How to handle pruned nodes? (Maybe require `txindex=1` or fallback to limited functionality.)
- Xpub derivation scope: only `receive` chain or include change? Configurable gap limit per PRD?
- Storage engine choice: LevelDB is lightweight but JS binding options vs sqlite/better-sqlite3 tradeoffs.

## Next Steps
1. Technical spike: evaluate LevelDB vs SQLite for storing address maps in Node.js (performance, bindings, ecosystem support).
2. Draft detailed indexer architecture (initial sync, incremental updates, reorg handling) with data model diagrams.
3. Update PRD Section 3/Scope with agreed address/xpub features; capture non-goals explicitly.
4. Extend RUNBOOK/TESTING outlines with indexer operations (build, verification, cleanup).

## References
- `docs/EXPANSION.md` — Mid-term milestone: Local Indexing & Address Explorer.
- `docs/PRD.md` — MVP scope/non-goals (no address/xpub yet).
- WebSocket/Metrics docs (`docs/design/metrics-exporter.md`, `docs/design/websocket-updates.md`) for instrumentation patterns to reuse.
