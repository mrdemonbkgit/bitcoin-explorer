# Address Indexer Performance Enhancement — Implementation Plan

## Task Tracker
- [ ] Development — (Dev)
  - [x] Add instrumentation for block processing and prevout fetch durations.
  - [x] Optimize RPC usage (connection pooling, batching, configurable concurrency).
  - [x] Evaluate LevelDB tuning (write buffer, compaction) and apply safe defaults.
  - [x] Implement optional parallel prevout fetcher guarded by config flag.
- [ ] Quality Assurance — (QA)
  - [x] Extend benchmarks (`npm run bench:address`) to record throughput before/after changes.
  - [ ] Add regression tests covering instrumentation output and parallel worker correctness.
- [ ] DevOps — (DevOps)
  - [ ] Document required Core settings and hardware expectations for acceptable sync speed.
  - [ ] Provide guidance for seeding LevelDB snapshot or disabling feature when not needed.
- [ ] Documentation — (Docs)
  - [ ] Update RUNBOOK/TESTING with tuning steps and interpretation of new metrics/log fields.
  - [ ] Summarize findings in CHANGELOG and WORKLOG on rollout.
- [ ] Product — (Product)
  - [ ] Validate improved sync targets with stakeholders and capture performance goals in PRD addendum.

## Overview
The LevelDB-backed address indexer currently syncs at ~1 block/sec on a local node, making first-time synchronization impractical. This plan focuses on measuring bottlenecks and delivering incremental throughput gains without compromising stability or the LAN-first philosophy.

## Goals
- Reduce full-chain sync time by at least 3× on a local Core node with SSD storage (target: >=3 blocks/sec sustained).
- Provide operators with visibility into sync progress (per-minute throughput, RPC latency, LevelDB batch timings).
- Offer configuration knobs to trade off CPU vs throughput (e.g., parallel prevout fetching) with conservative defaults.
- Update documentation so operators understand prerequisites, tuning steps, and fallback options.

## Non-Goals
- Building a new indexing backend (LevelDB remains).
- Supporting sharded/distributed indexing out of scope for this iteration.
- Guaranteeing performance on extremely constrained hardware (e.g., low-power SBCs) — focus on typical desktop/server environments.

## Implementation Steps

### 1. Instrumentation & Measurement (Dev, QA)
1. Extend logging/metrics:
   - Add debug-level timers around `processBlockHash`, `fetchPrevouts`, and `db.batch` (log `durationMs`).
   - Expose new Prometheus histograms: `explorer_address_indexer_block_duration_seconds`, `explorer_address_indexer_prevout_duration_seconds`.
2. Update `npm run bench:address` to record blocks/sec and transactions/sec in output JSON.
3. Document measurement steps in TESTING.

### 2. RPC Optimizations (Dev)
1. Review existing Axios client in `src/rpc.js`; increase keep-alive sockets if underutilized. ✅ — HTTP agent now respects `BITCOIN_RPC_MAX_SOCKETS` (default 16).
2. Introduce configurable concurrency for prevout RPC requests, defaulting to safe value (e.g., 4). ✅ — `ADDRESS_INDEXER_CONCURRENCY` drives a bounded worker pool (default 4).
3. Add fallback caching for recently fetched prevouts to avoid duplicate RPCs within a window. ✅ — LRU short-lived cache added with `ADDRESS_PREVOUT_CACHE_MAX` / `ADDRESS_PREVOUT_CACHE_TTL`.
4. Ensure `BITCOIN_RPC_TIMEOUT` can be raised for long-running batches without starving other requests. ✅ — Larger socket pools + concurrency guard prevent starvation when increasing timeouts.

### 3. LevelDB Tuning (Dev)
1. Evaluate Level constructor options (e.g., `cacheSize`, `writeBufferSize`). Benchmark safe defaults for typical hardware. ✅ — Level now honours `ADDRESS_LEVEL_CACHE_MB` (default 32) and `ADDRESS_LEVEL_WRITE_BUFFER_MB` (default 8) when opening the database.
2. Ensure LevelDB directory resides on SSD by documenting in RUNBOOK and warning in logs if heuristics indicate spinning disk (optional). ✅ — RUNBOOK notes SSD expectation and new tuning knobs; startup logs show cache/buffer values to aid ops verification.
3. Consider grouping multiple blocks per batch when safe (e.g., every 5 blocks) to reduce overhead. ✅ — `ADDRESS_INDEXER_BATCH_BLOCKS` (default 1) batches consecutive blocks during initial sync; logs include aggregated batch size to monitor LevelDB behaviour.

### 4. Parallelism Enhancements (Dev)
1. Prototype worker pool for prevout fetching using `Promise.allSettled` limited by concurrency config. ✅ — Prevout fetches now use a bounded concurrency helper when `ADDRESS_INDEXER_PARALLEL_ENABLED=true` (default).
2. Add config flag `ADDRESS_INDEXER_CONCURRENCY` to control worker count; default to conservative value. ✅ — Existing knob remains, with sequential fallback when parallelism disabled.
3. Ensure deterministic ordering and maintain atomic batch writes. ✅ — Results array preserves vin ordering regardless of parallelism.
4. Guard against overloading Core: log warnings when concurrency exceeds recommended values. ✅ — Startup warning emitted when configured workers exceed 8.

### 5. Operational Workarounds (DevOps, Docs)
1. Provide script/guide for seeding LevelDB from downloadable snapshot or previous run.
2. Document `FEATURE_ADDRESS_EXPLORER=false` as quick disable for low-resource environments.
3. Update RUNBOOK with recommended hardware (>=4 cores, SSD, local Core).

### 6. Validation & Rollout (QA, DevOps, Docs)
1. Run baseline vs optimized benchmarks (`bench:address`) and record results in repo (append to `bench/leveldb-results.json` with notes).
2. Use new metrics/logs during full sync to confirm target throughput.
3. Update README/RUNBOOK/TESTING/PRD with tuning notes and performance expectations.
4. Note changes in CHANGELOG and WORKLOG when merging.

## Risks & Mitigations
- **RPC overload**: Too aggressive concurrency can starve Core or cause rate limiting — default to conservative values, add warnings.
- **LevelDB stalls**: Larger write buffers may increase memory usage; document defaults and allow override.
- **Complexity creep**: Keep instrumentation optional and respect existing feature flags.

## Timeline Estimate
- Week 1: Instrumentation + baseline benchmarks.
- Week 2: RPC optimizations + LevelDB tuning experiments.
- Week 3: Optional parallelization prototype and validation.
- Week 4: Documentation updates, rollout, and retrospective on achieved throughput.

## References
- `src/infra/addressIndexer.js` — current sync pipeline.
- `scripts/bench/run-ci.js` — benchmark harness.
- `docs/RUNBOOK.md` — operator guidance to update.
