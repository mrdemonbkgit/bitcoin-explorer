# Work Log

Purpose: Lightweight, human-readable record of daily progress, decisions, and next steps. Use this alongside Task Trackers in `docs/design/*.md`, issues, and the CHANGELOG.

## How to use
- Add a new dated section per workday (reverse chronological).
- Summarise what changed, link PRs/issues, and reference the relevant design doc Task Tracker.
- Use Conventional Commits in PR titles and commit messages.
- Keep entries concise; details live in PRs/tests/design docs.

---

## Template
```
## YYYY-MM-DD
### Done
- <type(scope): summary> — (PR #<id> / Commit <sha>)
  - Context: <link to design doc / section>

### In Progress
- <task/area> — (Owner: <role or person>, Issue #<id>)

### Next
- <upcoming action or decision>

### Blockers/Risks
- <brief note and mitigation>

### Notes
- <optional observations, follow-ups, metrics>
```

---

## 2025-09-20
### Done
- fix(bench): add absolute tolerance thresholds to compare guard — (Commit 3c32c4d)
  - Context: `scripts/bench/compare-results.js` now supports millisecond absolute tolerances so nightly LevelDB benchmarks ignore tiny variance; README/TESTING mention the new knobs.
- test(regtest): stabilize address explorer coverage — (Commits 81cbb4c, 1d8ca4f, 4bb667c)
  - Context: Regtest harness provisions per-run LevelDB paths, retries `getblock` misses, waits for indexer catch-up, and skips xpub assertions when descriptors lack extended keys; docs updated with the new behavior.

### In Progress
- QA: add failure-injection coverage for LevelDB adapter restart scenarios (Refs Task Tracker in `docs/design/address-explorer.md`).

### Next
- Monitor nightly `benchmark-indexer` run to confirm the adjusted tolerances still flag real regressions while passing under normal variance.
- Evaluate capturing an extended xpub during smoke runs to re-enable full xpub assertions.

### Blockers/Risks
- Regtest wallet descriptors may not expose extended keys; address explorer API is still verified, but xpub coverage remains best-effort until deterministic descriptors are available.

### Notes
- Updated README/RUNBOOK/TESTING with the new harness expectations (unique index dir, indexer wait loop, optional xpub skip message).

---

## 2025-09-20
### Done
- chore(address): document leveldb benchmark results — (Commit 35f8c90)
  - Context: Added reusable harness outputs (`bench/leveldb-results.json`, `bench/sqlite-results.json`) and captured comparative metrics in `docs/design/address-explorer-leveldb-migration.md`.
- ci(address): add nightly indexer benchmark — (Commit d08f765)
  - Context: Introduced `benchmark-indexer` GitHub Actions job plus local helpers (`scripts/bench/run-ci.js`, `scripts/bench/compare-results.js`, `.gitignore` updates) to guard LevelDB ingest/read performance against regressions.
- docs(address): document leveldb benchmark workflow — (Commit b056143)
  - Context: README, TESTING, and RUNBOOK now describe how to run the benchmark guardrail locally and how CI publishes the `address-indexer-benchmark` artifact; migration plan notes the nightly job.

### In Progress
- QA: add failure-injection coverage for LevelDB adapter restart scenarios (Refs Task Tracker in `docs/design/address-explorer.md`).

### Next
- DevOps: monitor first nightly `benchmark-indexer` run and tune thresholds if ingest/read variance remains high.
- Docs: refresh PRD/RUNBOOK after benchmark data stabilises to reflect recommended thresholds.

### Blockers/Risks
- Benchmark deltas currently spike when chain height differs; consider extending seed routine to match baseline depth before tightening tolerances.

### Notes
- Remember to disable `METRICS_ENABLED`/`WEBSOCKET_ENABLED` after local verification unless the environment expects them.
