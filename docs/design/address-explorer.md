# Address/Xpub Explorer — Discovery & Design Plan

## Task Tracker
- [x] Development — (Dev)
  - [x] Evaluate storage options and document LevelDB choice.
  - [x] Implement indexer module ingesting transactions via RPC/ZMQ and persisting address→UTXO/tx mappings.
  - [x] Add backend services and routes for address/xpub lookup with pagination and summary statistics.
  - [x] Update Nunjucks views (address overview, transaction list) with SSR-first rendering.
  - [x] Harden initial sync checkpoints (atomic transactions, rollback on mismatch) and add graceful shutdown hooks.
- [ ] Quality Assurance — (QA)
  - [x] Design unit/integration tests covering index updates, lookup correctness, and pagination edge cases.
  - [x] Extend regtest smoke to seed addresses/xpubs and validate explorer output (optional CI toggle like `REGTEST_ADDRESS_CHECK`).
  - [ ] Add failure-injection tests that interrupt initial sync mid-block and confirm resume without reprocessing from height 0.
- [ ] DevOps — (DevOps)
  - [x] Document storage footprint, retention, and backup guidance in RUNBOOK; highlight new env vars/config for indexer.
  - [x] Ensure CI covers lint/typecheck/tests with the new indexer and address routes; monitor runtime impact.
  - [ ] Schedule nightly smoke to report checkpoint metrics and document operator recovery steps in RUNBOOK once resilience ships.
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
- Use LevelDB via the `level` Node.js package to maintain a lightweight embedded key-value store.
- Justification:
  - Handles multi-gigabyte datasets without a single large file; compactions keep storage bounded.
  - Atomic batch writes provide checkpoint durability comparable to the prior SQLite transactions.
  - Prefix iterators align with our logical tables while keeping implementation simple.
- Operational notes:
  - Default index directory `./data/address-index` (configurable via `ADDRESS_INDEX_PATH`).
  - LevelDB compaction settings remain at defaults initially; document tuning in the RUNBOOK as we learn.
  - Backups are performed by copying the directory or using LevelDB checkpoints when downtime is acceptable.

## Indexer Architecture
1. **Data Model**
   - `addr:<address>` summary records storing first/last seen height, totals, balances, and UTXO aggregates.
   - `utxo:<address>:<txid>:<vout>` entries holding value and height for each spendable output.
   - `tx:<address>:<height>:<direction>:<io_index>:<txid>` entries capturing chronological history for pagination.
   - `xpub:<fingerprint>:<branch>:<index>` records mapping derived paths to addresses and metadata.
   - `meta:<key>` checkpoints for schema version, last processed block hash/height, reorg checkpoints.

2. **Initial Sync**
   - Require `txindex=1`; pull best height, then iterate blocks via `getblockhash`/`getblock` to bootstrap.
   - For each transaction, decode inputs/outputs, map scriptPubKey to addresses (support P2PKH, P2SH, Bech32 v0/v1).
   - Batch inserts per block using atomic `db.batch` operations so checkpoints are durable.
   - Persist `last_processed_height/hash` after each committed block. Startup replay relies on these metadata keys; periodic validation can scan key prefixes if needed.

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
  - Persist data using LevelDB key prefixes; rely on atomic batches and prefix iteration for performance instead of SQL tables.
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

## Initial Sync Resilience Plan
- **Failure mode verification**: simulate process crashes and signal-driven shutdowns during initial sync to document which checkpoints persist today; capture findings in WORKLOG and use them as regression tests. Watch for new log events such as `addressIndexer.sync.halted` during these runs.
- **Atomic checkpoints**: finish each block inside a single LevelDB batch that writes both data rows and the `metadata` height/hash.
- **Startup reconciliation**: on boot, compare the stored `last_processed_height/hash` with the highest block represented in `addresses/address_txs`; if inconsistent, roll back to the last clean height before resuming.
- **Graceful shutdown**: add signal handlers so the indexer flushes in-flight blocks (stop fetching, commit current work, persist checkpoints) before the process exits.
- **Observability**: emit structured logs and Prometheus counters for checkpoint commits, rollbacks, shutdown flush duration, and resume events so operators know progress is durable.
- **Validation**: create automated tests (unit + regtest smoke) that interrupt sync mid-run and verify restart resumes from the saved checkpoint without reprocessing from genesis.

## Open Questions
- Source of truth for historical data: use `getrawtransaction` + `decoderawtransaction` or rely on `scantxoutset`/`importmulti` flows?
- Should the indexer maintain transaction history (spent outputs) or just UTXO snapshots + references?
- How to handle pruned nodes? (Maybe require `txindex=1` or fallback to limited functionality.)
- Xpub derivation scope: only `receive` chain or include change? Configurable gap limit per PRD?
- Storage engine choice: LevelDB is lightweight but JS binding options vs sqlite/better-sqlite3 tradeoffs.

## Next Steps
1. Plan the LevelDB migration (see `docs/design/address-explorer-leveldb-migration.md`) with the assumption that operators will reindex from genesis, not convert existing SQLite data.
2. Update PRD Section 3/Scope with agreed address/xpub features; capture non-goals explicitly.
3. Extend RUNBOOK/TESTING outlines with indexer operations (build, verification, cleanup) as storage changes land.

## References
- `docs/EXPANSION.md` — Mid-term milestone: Local Indexing & Address Explorer.
- `docs/PRD.md` — MVP scope/non-goals (no address/xpub yet).
- WebSocket/Metrics docs (`docs/design/metrics-exporter.md`, `docs/design/websocket-updates.md`) for instrumentation patterns to reuse.
