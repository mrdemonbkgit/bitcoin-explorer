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
  - Optional toggles:
    - `REGTEST_SCRAPE_METRICS=true` — scrape `/metrics` during the run.
    - `REGTEST_ADDRESS_CHECK=true` — enable the address/xpub explorer, wait for indexer sync, and assert `/address` + `/api/v1/address` + `/xpub` responses.

- Mid-term API + SSR milestone test additions are outlined in `docs/design/api-ssr-plan.md` (see Testing Strategy).

## 5. Post-Deployment Checklist
- Confirm `.env` includes the desired log level and ZMQ endpoints.
- Run `npm run build` to create the deployment artifact.
- Tail logs in production (journalctl or log aggregator) to ensure structured JSON is flowing.
- After deployment, run `npm run test:regtest` in CI (workflow_dispatch) or a staging environment for smoke validation.

Keep this document updated as new features land or testing strategy evolves.

## 6. API Smoke Checklist
1. Hit the tip endpoint: `curl http://<HOST>:<PORT>/api/v1/tip` and confirm `height`, `bestHash`, and fee estimates mirror the home page.
2. Use the returned `bestHash` (or height) to fetch block metadata: `curl http://<HOST>:<PORT>/api/v1/block/<block-id>` and verify `hash`, `height`, and pagination reflect the HTML `/block/<id>` view.
3. Retrieve a known transaction with `curl http://<HOST>:<PORT>/api/v1/tx/<txid>` and ensure totals (`inputValue`, `outputValue`, `fee`, `isRbf`) and resolved addresses align with the `/tx/<txid>` page.
4. If the mempool dashboard is enabled, run `curl http://<HOST>:<PORT>/api/v1/mempool` to spot the recent transaction list; compare it against the `/mempool` table during mempool growth and after confirmations.
5. Repeat the sequence after mining/broadcasting on regtest to watch the API reflect new state without restarting the server.

## 7. Metrics Exporter
1. Enable metrics locally by setting in `.env`:
   ```ini
   METRICS_ENABLED=true
   METRICS_PATH=/metrics
   ```
2. Hit the exporter with `curl http://<HOST>:<PORT>/metrics` and confirm it returns HTTP 200 along with series like `explorer_http_requests_total` and `explorer_rpc_requests_total`.
3. Trigger traffic (home page, `/api/v1/tip`, `/mempool`) and re-run the curl to ensure counters increment.
4. Optional: set `REGTEST_SCRAPE_METRICS=true` before `npm run test:regtest` to have the smoke suite verify the exporter during CI.
5. When metrics are disabled, the endpoint should return HTTP 404 with `Metrics disabled` in the body.
6. After validation, flip `METRICS_ENABLED` (and any related flags) back to `false` so production-like environments stay in their default posture unless operators explicitly enable scraping.

## 8. WebSocket Notifications
1. Enable WebSockets via `.env`:
   ```ini
   WEBSOCKET_ENABLED=true
   WEBSOCKET_PATH=/ws
   ```
2. Start the explorer and visit `/` and `/mempool` in a modern browser; open the console to confirm a WebSocket connection is established. Mine a block or broadcast a transaction (on regtest) and observe the UI updating without a page refresh.
3. If the WebSocket gateway is disabled, the client-side script remains inert and pages fall back to cached TTL behaviour.
4. For automated coverage, run `REGTEST_WS_CHECK=true npm run test:regtest`; the smoke suite will open a WebSocket and assert that at least one broadcast arrives during the block/tx scenarios.

## 9. Address/Xpub Explorer
1. Enable the feature in `.env`:
   ```ini
   FEATURE_ADDRESS_EXPLORER=true
   ADDRESS_INDEX_PATH=./data/address-index
   ADDRESS_XPUB_GAP_LIMIT=20
   ```
2. Start the explorer and monitor logs for `addressIndexer.sync.complete` (or `addressIndexer.sync.halted` if you intentionally stop it mid-way). Initial sync can take time depending on chain size.
3. Once synced, visit `/address/<known-address>` to verify balances, UTXOs, and transaction listings. Cross-check against `bitcoin-cli listunspent` for accuracy.
4. For xpubs, load `/xpub/<xpub>`; ensure derived addresses and totals align with wallet data. Adjust `ADDRESS_XPUB_GAP_LIMIT` if expected addresses fall outside the scanned range.
5. Optional: on regtest, interrupt the explorer mid-sync (Ctrl+C) and restart; the indexer should resume from the last logged height without replaying from genesis.
