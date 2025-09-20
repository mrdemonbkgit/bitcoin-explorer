# Address/Xpub Explorer — LevelDB Migration Plan

## Task Tracker
- [ ] Development — (Dev)
  - [ ] Evaluate LevelDB bindings and benchmark against current SQLite implementation.
  - [ ] Implement storage adapter abstraction and LevelDB-backed indexer flows (initial sync, updates, reorgs).
  - [ ] Wire configuration/feature flag to select LevelDB, defaulting to it once validated.
- [ ] Quality Assurance — (QA)
  - [ ] Add unit/integration tests covering the LevelDB adapter, including crash/restart scenarios.
  - [ ] Extend regtest smoke to rebuild with LevelDB and verify parity with existing responses.
- [ ] DevOps — (DevOps)
  - [ ] Ensure CI/build images ship LevelDB dependencies and native modules (or use prebuilt binaries).
  - [ ] Update RUNBOOK/monitoring for LevelDB operational guidance and metrics.
- [ ] Documentation — (Docs)
  - [ ] Update README/PRD/CHANGELOG with LevelDB rollout details and reindex-from-genesis instructions.

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

## Documentation & Rollout
- Update design docs (this plan + `docs/design/address-explorer.md`) with Task Tracker entries for migration milestones.
- Prepare upgrade guide: prerequisites, re-index steps, verification commands, rollback instructions.
- Communicate change in CHANGELOG/PRD, emphasizing dependency footprint and operational shifts.

## Open Questions
- Storage format for multi-value lookups (embedded secondary indices vs denormalized keys).
- Compaction tuning defaults for LAN deployments (targeted level sizes, write buffer limits).
- Backup/restore tooling expectations (snapshot via LevelDB checkpoints vs file copy).

## Next Steps
1. Evaluate bindings and produce benchmark results (write/read latency) vs SQLite baseline.
2. Prototype persistence adapter with minimal features (metadata + address summaries) and validate sync throughput.
3. Expand adapter to cover full data model, implement reorg handling, and add parity tests against current implementation.
4. Iterate on migration tooling/documentation based on operator feedback.
