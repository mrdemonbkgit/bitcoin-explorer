# Address/Xpub Explorer — LevelDB Migration Plan

## Task Tracker
- [x] Development — (Dev)
  - [x] Capture LevelDB vs SQLite ingest/read benchmarks and document findings in this plan.
  - [x] Implement storage adapter abstraction and LevelDB-backed indexer flows (initial sync, updates, reorgs).
  - [x] Default the explorer to the LevelDB backend via configuration/feature toggle and retire the SQLite path.
- [x] Quality Assurance — (QA)
  - [x] Extend regtest smoke to rebuild with LevelDB and verify parity with existing responses.
- [x] DevOps — (DevOps)
  - [x] Ensure CI/build images ship LevelDB dependencies and use the package-provided prebuilds where available.
  - [x] Update RUNBOOK/monitoring for LevelDB operational guidance and metrics.
- [x] Documentation — (Docs)
  - [x] Update README/PRD/CHANGELOG with LevelDB rollout details and reindex-from-genesis instructions.

### Status Notes (2025-09-20)
- LevelDB-backed indexer is live with atomic batches, graceful shutdown, and progress logging (`src/infra/addressIndexer.js`).
- Regtest smoke and CI cron job now exercise the LevelDB explorer via `REGTEST_ADDRESS_CHECK=true`.
- LevelDB vs SQLite ingest/read benchmarks captured (see "Benchmark Results" section); next focus is failure-injection coverage to validate crash/restart resilience.

## Goals & Constraints
- Replace SQLite with LevelDB (via the `level` package) to better handle multi-gigabyte datasets without a monolithic database file.
- Preserve LAN-first deployment, deterministic rebuild capability, and existing API/SSR contracts.
- Avoid introducing external services or daemons; keep the indexer an embedded store.

## Discovery Tasks
- Benchmark Node.js LevelDB bindings (`level`, `classic-level`) against current workload: block batch ingestion, UTXO lookups, paginated history reads.
- Document parity gaps with SQLite features we rely on (transactions, atomic writes) and note compensating patterns (atomic batches, prefix iteration).
- Assess build/runtime implications: native module prebuilds, binary sizes, container support, required system libraries.

## Data Model Mapping
- Define key prefixes/column families:
  - `meta:<key>` — checkpoints, schema version, settings.
  - `addr:<address>` — serialized address summary payloads.
  - `utxo:<address>:<txid>:<vout>` — UTXO entries.
  - `tx:<address>:<height>:<direction>:<io_index>` — transaction history rows.
  - `xpub:<fingerprint>:<branch>:<index>` — derived address metadata.
- Choose serialization format (MsgPack vs JSON) and compression strategy; validate backward compatibility for future schema migrations.
- Decide whether to rely on a single LevelDB store with key prefixes or additional sublevels per entity; capture trade-offs (compaction separation, memory footprint).

## Indexer Refactor
- Introduce persistence adapter interface consumed by `AddressIndexer` so SQLite and LevelDB implementations can coexist during transition.
- Implement LevelDB adapter with:
  - Block-scoped atomic batches (`db.batch`) for checkpoint durability.
  - Iterators supporting range scans for pagination and UTXO aggregation.
  - Consistent checkpoint updates (`meta:last_processed_height/hash`).
- Rework initial sync, incremental updates, and reorg handling to use adapter abstractions while keeping business logic intact.

## Migration Strategy
- Re-index from genesis using LevelDB; document downtime expectations, disk requirements, and expected duration. No live data migration from existing SQLite databases is planned—the index will be rebuilt.
- Provide feature flag/env to choose backend (`ADDRESS_STORE=sqlite|level`) with LevelDB as default once validated, retaining SQLite for rollback during early rollout.

## Operational Considerations
- Update RUNBOOK with LevelDB deployment notes (filesystem layout, compaction tuning where applicable, backup strategy).
- Extend metrics exporter with LevelDB stats (compaction count, file counts) if surfaced by the binding.
- Ensure CI/dev environments include LevelDB-native dependencies or leverage prebuilt binaries; add caching for native build artifacts where possible.

## Testing & Validation
- Unit tests for the persistence adapter (batched writes, iterators, checkpoint resilience).
- Integration tests comparing LevelDB-backed explorer responses vs SQLite baseline for identical regtest scenarios.
- Fault-injection tests simulating crashes during sync to verify checkpoints and recovery match expectations.
- Soak tests on large datasets to monitor memory/CPU, compaction behaviour, and restart times.

## Benchmark Results (2025-09-20)
- Environment: Node.js 24.8.0 on Linux 6.11 (8 vCPU), local `bitcoind -regtest -txindex=1` seeded via `generatetoaddress` plus ~600 wallet transfers to 50 sampled addresses.
- Methodology: `scripts/bench/address-indexer-bench.js --sample 50 --warmups 1 --iterations 3` against the shared regtest dataset; SQLite numbers captured by running the same script inside commit `f842843` (pre-LevelDB) pointed at the identical node.
- Artifacts: raw metrics recorded in `bench/leveldb-results.json` and `bench/sqlite-results.json`.

| Backend | Ingest (s) | Address summary avg (ms) | Tx history avg (ms) | UTXO lookup avg (ms) |
| --- | --- | --- | --- | --- |
| LevelDB | 2.16 | 0.025 | 0.235 | 0.103 |
| SQLite | 2.08 | 0.051 | 0.150 | 0.023 |

- Findings:
  - LevelDB initial ingest sits within ~4% of the SQLite baseline on the current 226-block dataset (2.16s vs 2.08s).
  - Keyed lookups (`getAddressSummary`) remain ~2× faster with LevelDB because summaries live in single-key JSON documents derived from Level prefixes.
  - Iteration-heavy reads (transaction history, UTXO listing) still favour SQLite’s indexed queries; LevelDB would benefit from sorted sublevel prefixes or cached aggregates to close the gap.

## Documentation & Rollout
- Update design docs (this plan + `docs/design/address-explorer.md`) with Task Tracker entries for migration milestones.
- Prepare upgrade guide: prerequisites, re-index steps, verification commands, rollback instructions.
- Communicate change in CHANGELOG/PRD, emphasizing dependency footprint and operational shifts.
- Nightly CI now runs `benchmark-indexer` (GitHub Actions) to compare fresh LevelDB runs against the checked-in baseline and fail on regressions over the configured thresholds.

## Open Questions
- Storage format for multi-value lookups (embedded secondary indices vs denormalized keys).
- Compaction tuning defaults for LAN deployments (targeted level sizes, write buffer limits).
- Backup/restore tooling expectations (snapshot via LevelDB checkpoints vs file copy).

## Next Steps
1. Prototype LevelDB-side optimisations for transaction/UTXO iteration (sorted sublevel prefixes, cached aggregates) to narrow the remaining read latency gap.
2. Expand adapter parity tests to cover reorg rollback and resumable sync using the new benchmarking harness as a regression gate.
3. Iterate on migration tooling/documentation based on operator feedback.
