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
- feat(tx): surface resolved addresses on transaction view & API — (Pending)
  - Context: `src/services/bitcoinService.js`, `views/tx.njk`, tests, and docs (`README.md`, `docs/API.md`, `docs/TESTING.md`, `docs/PRD.md`, `docs/design/api-ssr-plan.md`).
- feat(metrics): add Prometheus exporter with instrumentation — (Commit 0ee2879)
  - Context: `docs/design/metrics-exporter.md` Task Tracker completed; updated README/RUNBOOK/TESTING for env flags and smoke steps.
- feat(websocket): deliver LAN WebSocket notifications + client hydration — (Commit d594bfd)
  - Context: `docs/design/websocket-updates.md` Task Tracker completed; home/mempool pages now auto-refresh using `/api/v1` data; optional regtest WS check added.
- feat(address): ship SQLite-backed address/xpub explorer with SSR/API routes — (Commit f842843)
  - Context: `docs/design/address-explorer.md` Task Tracker completed; indexer syncs via RPC/ZMQ, new `/address/:id` & `/xpub/:key` views/APIs, docs updated (README/RUNBOOK/TESTING) with env guidance.
- docs(worklog): note resetting metrics flags after verification — (Commit 584f9c7)
- docs(design): add WebSocket notifications plan + Task Tracker updates — (Commit 80fec11)

### In Progress
- docs/process: adopt Conventional Commit titles/messages across open PRs (Owner: Docs/Product)

### Next
- feat(address): draft design for address/xpub explorer with local index (Ref: `docs/EXPANSION.md` Mid-Term milestone)
- ci: extend regtest smoke to toggle WS metrics checks in CI nightly run

### Blockers/Risks
- Conventional Commit adoption retroactively for existing commits may require rebase if we decide to enforce strictly.

### Notes
- Remember to disable `METRICS_ENABLED`/`WEBSOCKET_ENABLED` after local verification unless the environment expects them.

## 2025-09-19
### Done
- docs(agents): add Task Tracker convention; adopt Conventional Commits — (PR pending)
- docs: add WORKLOG with usage and template — this file

### In Progress
- docs(design): add Task Tracker sections to `near-term-phase1.md` and `api-ssr-plan.md`

### Next
- ci: add PR template enforcing Conventional Commits + Task Tracker link
- test: wire unit tests into CI once suites stabilise

### Blockers/Risks
- None today

### Notes
- Keep Task Tracker checkboxes updated during PRs; “done” = merged to `main`.
