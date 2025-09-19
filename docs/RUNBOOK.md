# Slim Bitcoin Explorer — Runbook

## Overview
The explorer is a Node.js 24.8 service that exposes read-only Bitcoin data over HTTP for local network clients. It talks directly to Bitcoin Core via JSON-RPC and keeps state only in memory caches.

## Contacts
- Product: see `AGENTS.md`
- DevOps: see `AGENTS.md`

## Dependencies
- Node.js 24.8.0 runtime
- Bitcoin Core with `server=1`, `rpcallowip=127.0.0.1`, `rpcbind=127.0.0.1`, and `txindex=1`
- Either RPC cookie access (default: `~/.bitcoin/.cookie`) or static RPC credentials

## Configuration
Populate `.env` in the project root (see `docs/env.sample`):
```
BITCOIN_RPC_URL=http://127.0.0.1:8332
# Option A: cookie-based auth
BITCOIN_RPC_COOKIE=/home/bitcoin/.bitcoin/.cookie
# Option B: static credentials from bitcoin.conf
BITCOIN_RPC_USER=<rpcuser>
BITCOIN_RPC_PASSWORD=<rpcpassword>
APP_BIND=0.0.0.0
APP_PORT=28765
CACHE_TTL_TIP=5000        # ms
CACHE_TTL_BLOCK=600000
CACHE_TTL_TX=600000
BITCOIN_RPC_TIMEOUT=3000
```

Additional environment controls:
- `BITCOIN_ZMQ_BLOCK` / `BITCOIN_ZMQ_TX` — optional ZMQ endpoints for raw block/tx notifications to invalidate caches immediately.
- `CACHE_TTL_MEMPOOL` — TTL (ms) for the mempool snapshot cache (default 5s).
- `LOG_LEVEL`, `LOG_PRETTY` — structured logging verbosity and formatting.
- `FEATURE_MEMPOOL_DASHBOARD` — disable the `/mempool` route when set to `false`.
- `METRICS_ENABLED`, `METRICS_PATH`, `METRICS_INCLUDE_DEFAULT` — toggle the Prometheus metrics endpoint (default `/metrics` on the main bind). Leave disabled unless scraping from a trusted LAN host.

## Deployment
```bash
# install dependencies
npm install

# run with file watching (development)
npm run dev

# start the service (production)
npm start

# optional: regression smoke suite (requires bitcoind binary)
npm run test:regtest
```
- `npm run build` packages the app into `dist/` with production dependencies (ready to rsync/deploy).
- Add a process supervisor (systemd, pm2) when moving beyond manual runs.

### ZMQ Configuration
- Enable the following in `bitcoin.conf` for realtime cache invalidation:
  ```ini
  zmqpubrawblock=tcp://127.0.0.1:28332
  zmqpubrawtx=tcp://127.0.0.1:28333
  ```
- Mirror the same URIs in the explorer `.env` (`BITCOIN_ZMQ_BLOCK`, `BITCOIN_ZMQ_TX`).


## Health Checks
- HTTP GET `/` should return 200 with the latest chain tip and mempool figures.
- JSON API endpoints (`/api/v1/tip`, `/api/v1/block/:id`, `/api/v1/tx/:txid`, `/api/v1/mempool`) should return 200 with expected payloads; inspect structured logs for request IDs when debugging.
- `/block/<height>` and `/tx/<txid>` should render without 5xx responses for known values.
- Monitor logs for `503` responses; these indicate Bitcoin Core RPC connectivity issues.

## Logging
- Logs emit JSON via `pino`; default level is `info`. Adjust with `LOG_LEVEL`.
- Use `LOG_PRETTY=true` locally for human-friendly output.
- Pipe stdout/stderr into journald/systemd or ship to your log aggregator.

## Metrics Exporter
- Enable metrics by setting `METRICS_ENABLED=true` (and optionally `METRICS_PATH` if `/metrics` conflicts with an upstream component). Keep the endpoint LAN-limited; expose it via reverse proxy or firewall rules as needed.
- The explorer exposes Prometheus text format counters/histograms for HTTP requests, Bitcoin RPC calls, cache hits/misses, and ZMQ events. Example scrape job:
  ```yaml
  - job_name: 'bitcoin-explorer'
    scrape_interval: 15s
    static_configs:
      - targets: ['node.lan:28765']
  ```
- Set `METRICS_INCLUDE_DEFAULT=true` to export Node.js process metrics (heap usage, event loop lag). Default is `false` to avoid leaking host data.
- When troubleshooting, `curl http://<host>:<port>/metrics` should return 200 with `explorer_http_requests_total`; if disabled it returns 404.

## Incident Response
1. Confirm Bitcoin Core RPC availability (`bitcoin-cli getblockcount`).
2. Check service process status (`ps aux | grep node`).
3. Review recent logs for RPC timeouts or parsing failures.
4. Restart the service if the Node process is unresponsive.

## Maintenance
- Apply OS patches monthly.
- Update npm dependencies quarterly or when security advisories appear.
- Rotate the RPC cookie if the Bitcoin Core user changes.
- Exercise the regtest smoke suite (`npm run test:regtest`) after major upgrades to validate end-to-end behaviour.
- Refer to `docs/TESTING.md` for a detailed manual/automated test checklist when preparing releases.
- Coordinate mid-term roadmap work using `docs/EXPANSION.md` (Mid-Term milestone) and the implementation blueprint in `docs/design/api-ssr-plan.md`; update this runbook as deployment steps evolve.

Refer to `docs/PRD.md` for feature scope and `AGENTS.md` for ownership roles.
