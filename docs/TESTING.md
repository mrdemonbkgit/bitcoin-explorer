# Testing Guide — Slim Bitcoin Explorer

This guide captures manual and automated checks for the near-term feature bundle (structured logging, ZMQ cache busting, mempool dashboard, regtest smoke suite). Use it as a quick reference before releases or when verifying new environments.

## 1. Structured Logging
1. Set in `.env`:
   ```ini
   LOG_LEVEL=debug
   LOG_PRETTY=true
   ```
2. Run the app (`npm run dev` or `npm start`).
3. Trigger several routes:
   - `GET /`
   - `GET /block/<known height>`
   - `GET /search?q=missing` (expect 404)
4. Confirm console output shows JSON (or pretty) logs with:
   - `request.start` / `request.finish` entries containing `requestId`, `route`, `status`, `durationMs`.
   - `rpc.success`/`rpc.failure` entries listing RPC method and duration.
   - `request.error` entries for 404/500 cases with stack traces.

## 2. ZMQ Cache Busting
1. Ensure Bitcoin Core has ZMQ enabled (e.g. in `bitcoin.conf`):
   ```ini
   zmqpubrawblock=tcp://127.0.0.1:28332
   zmqpubrawtx=tcp://127.0.0.1:28333
   ```
2. Mirror URIs in `.env` (`BITCOIN_ZMQ_BLOCK`, `BITCOIN_ZMQ_TX`).
3. Launch Core and the explorer with `LOG_LEVEL=debug`.
4. Trigger Core events:
   - Mine a block (`bitcoin-cli generatetoaddress 1 <addr>` on regtest).
   - Broadcast a tx (`bitcoin-cli sendtoaddress ...`).
5. Watch explorer logs for `zmq.subscribe` followed by `zmq.message` entries.
6. Reload `/` and `/mempool` within ~1s and verify:
   - Home page height/hash update immediately.
   - Mempool dashboard shows the new transaction before TTL expiry.

## 3. Mempool Dashboard UX
1. Visit `/mempool` with feature flag enabled (`FEATURE_MEMPOOL_DASHBOARD=true`).
2. Check that the summary, histogram, and recent tx table render without errors.
3. Broadcast a transaction and confirm it appears with the expected fee rate/age.
4. Mine a block and verify the transaction leaves the table.
5. For larger mempools, test pagination (`?page=2`).

## 4. Automated Suites
- **Unit/Integration:** `npm run test` (or `npm run coverage`). Ensures cache invalidation, logging utilities, and routes behave as expected.
- API parity tests (`test/integration/api.test.js`, `test/integration/parity.test.js`) verify that `/api/v1` responses stay aligned with their HTML counterparts.
- **Quality Gate:** `npm run ci` (lint → typecheck → coverage) for local parity with GitHub Actions.
- **Regtest Smoke:** `npm run test:regtest`
  - Requires `bitcoind` in PATH.
  - Validates end-to-end flows (ZMQ, mempool updates, cache invalidation) against a temporary regtest node.

## 5. Post-Deployment Checklist
- Confirm `.env` includes the desired log level and ZMQ endpoints.
- Run `npm run build` to create the deployment artifact.
- Tail logs in production (journalctl or log aggregator) to ensure structured JSON is flowing.
- After deployment, run `npm run test:regtest` in CI (workflow_dispatch) or a staging environment for smoke validation.

Keep this document updated as new features land or testing strategy evolves.
