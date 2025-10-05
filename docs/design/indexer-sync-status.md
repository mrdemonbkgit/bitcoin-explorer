# Indexer Sync Status Indicator — Implementation Note

## Task Tracker
- [x] Development — (Dev)
  - [x] Implement an indexer status endpoint exposing progress metrics (height, hash, throughput, ETA).
  - [x] Add frontend banner/component with polling to surface sync state and estimated completion.
- [x] Quality Assurance — (QA)
  - [x] Add unit and integration coverage for the status endpoint contract and frontend states (catching up, synced, errored).
  - [x] Extend regtest or smoke harness to simulate partial sync and validate the UI reflects progress accurately.
- [x] DevOps — (DevOps)
  - [x] Document operational metrics/alerts for sync lag and ensure Prometheus scrape/alerts cover the new gauges.
  - [x] Update RUNBOOK with guidance on interpreting throughput/ETA values and responding to stalled syncs.
- [x] Documentation — (Docs)
  - [x] Refresh README and RUNBOOK sections describing initial indexer boot, highlighting the new status indicator and troubleshooting tips.
- [x] Product — (Product)
  - [x] Approve UX copy, placement, and polling cadence to ensure the indicator aligns with LAN-only expectations and PRD requirements.

## Overview
Expose the address indexer’s initial sync progress directly in the explorer UI so operators can see current height, throughput, and estimated completion time without querying logs. This feature relies on existing instrumentation while adding a lightweight status API and frontend banner.

## Goals
- Surface real-time sync metrics (current height, target height, blocks per second, ETA) within explorer pages.
- Provide clear messaging when the indexer is catching up, complete, or encountering errors.
- Keep polling lightweight and privacy-preserving for LAN deployments.

## Non-Goals
- Building a generic system health dashboard beyond the indexer sync context.
- Exposing sync status to unauthenticated WAN clients; scope remains LAN-only.
- Replacing existing Prometheus metrics or detailed logs.

## Data & API Contract (Dev)
- Introduce `/api/v1/indexer/status` (or extend an existing status endpoint) returning JSON fields:
  - `lastProcessedHeight`, `lastProcessedHash` – current indexer checkpoint.
  - `targetHeight`, `targetHash` – blockchain tip from Bitcoin Core.
  - `blocksRemaining`, `progressPercent` – derived progress markers.
  - `blocksPerSecond`, `transactionsPerSecond` – rolling averages from instrumentation.
  - `estimatedCompletionMs` – ETA calculation using moving average throughput.
  - `updatedAt` – timestamp for freshness.
- Ensure endpoint respects feature flags (`FEATURE_ADDRESS_EXPLORER`) and returns a disabled state when the explorer is off.
- Leverage existing metrics collectors; if necessary, add in-memory rolling windows updated each block to avoid expensive recalculations on every request.

## Frontend UX (Dev/Product)
- Display a dismissible (when synced) banner near the explorer header summarising:
  - Progress bar or percentage.
  - Current vs target height (e.g., `Height 720000 / 848000`).
  - Estimated throughput (`~3.2 blocks/sec`) and ETA.
  - Tooltip or secondary text for error state with link to RUNBOOK troubleshooting.
- Poll the status endpoint every 5 seconds while progress < 100%; back off to 10 seconds on degraded/error states and 30 seconds once synced.
- Ensure SSR renders a first snapshot using server-fetched data, with client-side hydration updating in real time.
- Handle offline/error cases gracefully (e.g., show “Status unavailable, retrying…” with backoff).

### Product Decisions
- Copy stays terse and LAN-focused: “Indexer catching up to local chain tip” during sync, “Indexer synced with local chain tip” once complete, and “Indexer degraded - see RUNBOOK” when degraded.
- Poll cadence: 5 seconds while syncing, 10 seconds when degraded, and 30 seconds once synced to minimise LAN chatter while keeping the banner fresh.
- Banner is scoped to address-enabled deployments and hides automatically when the feature flag is off to avoid confusing non-indexer users.

## Metrics & Calculations (DevOps)
- Use the existing `explorer_address_indexer_block_duration_seconds` histogram to derive throughput samples; the API exposes rolling averages produced from the last 120 block completions.
- Calculate ETA as `blocksRemaining / avgBlocksPerSecond` with safeguards when throughput is zero or stale (return null instead of infinity).
- Publish dedicated Prometheus gauges: `explorer_address_indexer_blocks_remaining`, `explorer_address_indexer_sync_eta_seconds`, `explorer_address_indexer_progress_percent`, `explorer_address_indexer_tip_height`, `explorer_address_indexer_last_processed_height`, `explorer_address_indexer_sync_in_progress`, and `explorer_address_indexer_state{state="<value>"}`. Alert when blocks remaining stalls for >15 minutes or ETA exceeds agreed SLAs.
- Continue exporting prevout and block duration histograms for latency triage.

## Testing Strategy (QA)
- Unit tests for the status API covering normal, disabled, and error states.
- Frontend component tests verifying rendering for catching-up, synced, and error snapshots (using React testing helpers or SSR checks).
- Integration/regtest scenario: throttle the indexer or reset height to simulate initial sync, ensure status values and UI update over time.
- Smoke test should confirm ETA decreases and banner hides once synced.

## Documentation & Operational Updates (Docs/DevOps)
- Update RUNBOOK initial setup steps to reference the UI indicator and expected throughput ranges.
- Document API contract in `docs/API.md` if exposed publicly and note Grafana/dashboard implications.
- Add WORKLOG entry upon completion linking to this note and summarising decisions.

## Open Questions
- Should the status endpoint require authentication or rely on existing LAN trust assumptions?
- Do we need a configurable polling interval or allow operators to disable the banner entirely?
- How should the UI behave for partial re-syncs (e.g., after reorg rollback) versus first-time bootstrap?
