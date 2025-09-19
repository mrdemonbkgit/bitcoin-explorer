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

## Deployment
```bash
# install dependencies
npm install

# run with file watching (development)
npm run dev

# start the service (production)
npm start
```
- `npm run build` is a placeholder until a dedicated build/test pipeline exists.
- Add a process supervisor (systemd, pm2) when moving beyond manual runs.

## Health Checks
- HTTP GET `/` should return 200 with the latest chain tip and mempool figures.
- `/block/<height>` and `/tx/<txid>` should render without 5xx responses for known values.
- Monitor logs for `503` responses; these indicate Bitcoin Core RPC connectivity issues.

## Logging
- Console output (stdout/stderr) only. Pipe to journald/systemd for persistence.
- TODO: integrate structured logging once the server implementation lands.

## Incident Response
1. Confirm Bitcoin Core RPC availability (`bitcoin-cli getblockcount`).
2. Check service process status (`ps aux | grep node`).
3. Review recent logs for RPC timeouts or parsing failures.
4. Restart the service if the Node process is unresponsive.

## Maintenance
- Apply OS patches monthly.
- Update npm dependencies quarterly or when security advisories appear.
- Rotate the RPC cookie if the Bitcoin Core user changes.

Refer to `docs/PRD.md` for feature scope and `AGENTS.md` for ownership roles.
