# Address/Xpub Explorer — Discovery & Design Plan

## Task Tracker
- [x] Development — (Dev)
  - [x] Evaluate storage options and document SQLite choice.
  - [x] Implement indexer module ingesting transactions via RPC/ZMQ and persisting address→UTXO/tx mappings.
  - [x] Add backend services and routes for address/xpub lookup with pagination and summary statistics.
  - [x] Update Nunjucks views (address overview, transaction list) with SSR-first rendering.
- [ ] Quality Assurance — (QA)
  - [x] Design unit/integration tests covering index updates, lookup correctness, and pagination edge cases.
  - [ ] Extend regtest smoke to seed addresses/xpubs and validate explorer output (optional CI toggle like `REGTEST_ADDRESS_CHECK`).
- [x] DevOps — (DevOps)
  - [x] Document storage footprint, retention, and backup guidance in RUNBOOK; highlight new env vars/config for indexer.
  - [x] Ensure CI covers lint/typecheck/tests with the new indexer and address routes; monitor runtime impact.
- [x] Documentation — (Docs)
  - [x] Update README/TESTING with address explorer instructions and caveats (e.g., index build time, privacy notes).
  - [x] Add changelog entry when feature ships; cross-reference PRD/roadmap.
- [x] Product — (Product)
  - [x] Confirm scope (address summary fields, xpub support, rate limits) with stakeholders; update PRD/requirements as needed.

## Background & Goals
- Provide LAN operators with address/xpub visibility using data derived from their own Bitcoin Core node.
- Keep Bitcoin Core the source of truth; the indexer should be reproducible, bounded in size, and avoid external dependencies.
- Maintain SSR-first UX consistent with existing pages; JSON API parity can follow.

## Non-Goals
- Full Chain analytics, batching, or external data sources beyond Core RPC/ZMQ.
- Address clustering, tagging, or heuristic analysis (future roadmap).
- Replacing the indexer with Core’s `txindex` (assume `txindex=1` is present, but we still build derived address maps).

## Storage Choice
- Use SQLite 3.50.4 (latest stable as of 2025-09-20) via the `better-sqlite3` Node.js binding for a synchronous, zero-ORM interface.
- Justification:
  - Mature, battle-tested on embedded systems with robust ACID guarantees.
  - Single-file database simplifies backup/restore and aligns with the “no external services” constraint.
  - Deterministic synchronous API pairs well with the indexer loop without additional worker threads.
- Operational notes:
  - Default DB location `./data/address-index.db` (configurable via `ADDRESS_INDEX_PATH`).
  - Enable WAL mode for concurrent reads while the indexer writes (`PRAGMA journal_mode=WAL`).
  - Enforce `PRAGMA foreign_keys=ON` and `PRAGMA synchronous=NORMAL` to balance safety and performance.

## Indexer Architecture
1. **Data Model**
   - `addresses` table: `address TEXT PRIMARY KEY`, `first_seen_height`, `last_seen_height`, `total_received_sat`, `total_sent_sat`, `balance_sat`, `tx_count`.
   - `address_utxos`: composite primary key `(address, txid, vout)` storing `value_sat`, `height`, `script_pub_key`.
   - `address_txs`: `(address, txid, height, direction ENUM('in','out'), value_sat, timestamp)` for chronological history.
   - `xpubs`: store registered xpubs, gap limit, last derivation indices; `xpub_addresses` maps derived path to address + metadata.
   - `metadata`: key/value store for schema version, last processed block hash/height, reorg checkpoints.

2. **Initial Sync**
   - Require `txindex=1`; pull best height, then iterate blocks via `getblockhash`/`getblock` to bootstrap.
   - For each transaction, decode inputs/outputs, map scriptPubKey to addresses (support P2PKH, P2SH, Bech32 v0/v1).
   - Batch inserts per block using prepared statements; wrap blocks in transactions for atomicity.
   - Provide resumable sync by persisting last synced height/hash in `metadata`.

3. **Incremental Updates**
   - Subscribe to existing ZMQ `rawblock` and `rawtx` streams. On new block:
     - Process as in bootstrap, then update `metadata.last_processed_height/hash`.
     - Remove spent UTXOs from `address_utxos`, adjust balances and histories.
   - On mempool `rawtx`, insert provisional records tagged `height = NULL`; reclassify when block arrives.
   - Maintain a lightweight queue with retry/backoff for transient RPC issues.

4. **Reorg Handling**
   - Track block ancestry in `metadata`. When a reorg is detected (new block parent mismatch):
     - Roll back affected blocks by replaying stored block transactions in reverse (using a rollback log table or `address_txs` entries with block heights).
     - Reapply the new chain segment.
   - Keep a configurable `REORG_DEPTH_LIMIT` (default 6) with alerts/logging if exceeded.

5. **Xpub Support**
   - Store registered xpubs with derivation paths (external/internal) and maintain a scanning queue respecting `ADDRESS_GAP_LIMIT` (default 20).
   - Derive addresses using BIP32 (via `bitcoinjs-lib` or similar), insert into `xpub_addresses`, and link to `addresses` entries.
   - Provide API/SSR endpoints to register/remove xpubs (feature-flagged) and display aggregated balances per branch.

6. **APIs & Views**
   - `/address/:id`: fetch summary from `addresses`, list UTXOs (default page size 25), include recent transactions from `address_txs`.
   - `/xpub/:key`: show derived branch summary, balances, list of active addresses with balances, pagination for transactions.
   - JSON counterparts under `/api/v1/address/:id` and `/api/v1/xpub/:key` for parity (optional in first iteration but recommended for alignment).

7. **Operational Hooks**
   - Expose metrics: new counters for index sync progress, reorgs, pending mempool entries, xpub derivations.
   - Add CLI utilities (future) for rebuilding or pruning the index; document manual steps in RUNBOOK.

## Requirements (Draft)
- Address page (`/address/:id`): show summary (balance, UTXO count, total received/sent), recent transactions with pagination, links to `/tx/:txid` and relevant blocks.
- Xpub page (`/xpub/:key`): support BIP32 key derivation limited to a configured gap limit (default 20); display derived addresses and balances.
- Indexer:
  - Initialise by scanning blocks sequentially (requires `txindex=1`); resumable via `metadata` checkpoints.
  - Persist data in SQLite tables as outlined above; use WAL mode and prepared statements for performance.
  - Subscribe to ZMQ (`rawtx`, `rawblock`) for near-real-time updates; handle reorgs with rollback log.
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
