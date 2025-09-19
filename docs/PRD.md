# Slim Bitcoin Explorer — PRD (Basis-Only, LAN Direct Bind)

## 1) Summary
A **local-LAN accessible**, read-only Bitcoin block explorer implemented with a single **Node.js web service** that talks directly to **Bitcoin Core JSON-RPC** on the same machine. No database, no background indexers, no proxy (Nginx), and no runtime resource boundaries. It binds directly to an **unusual high port** to avoid conflicts.

**Primary outcome:** Fast, reliable pages for **Home**, **Block**, **Transaction**, and **Search**, with minimal system impact and simple deployment.

### Tech Stack
- Node.js 24.8 runtime (ES modules)
- Express 5 for routing and HTTP server
- Nunjucks templating for server-rendered HTML views
- Axios for Bitcoin Core JSON-RPC calls
- lru-cache for lightweight in-memory caching with TTLs
- dotenv for environment configuration and stricter defaults via `zod`

---

## 2) Goals & Non‑Goals
**Goals**
- Essential on-chain visibility from your own node:
  - Tip info (height/hash), mempool size/bytes, basic fee targets.
  - Block view by height/hash with header + tx count and paginated txids.
  - Transaction view with inputs/outputs, totals, vsize/weight, locktime, RBF hint.
  - One search box that routes to block or tx.
- Expose the explorer to **local LAN** directly on `0.0.0.0:<port>`.

**Non‑Goals (MVP)**
- No address/xpub/descriptor pages.
- No analytics, charts, mempool browser, WebSockets/SSE, or ZMQ.
- No Postgres/Redis; no background indexers.
- No reverse proxy (Nginx) or systemd CPU/RAM caps.

---

## 3) Scope (Functional Requirements)
**Pages**
1. **Home (`/`)**
   - Show: chain name, best block **height & hash**, mempool **tx count/bytes**, `estimatesmartfee` for **1/3/6** blocks.
   - Search box (height/hash/txid) → submits to `/search?q=...`.

2. **Block (`/block/{id}`)**
   - `{id}` accepts **height** or **hash**.
   - Render: header (time, size, weight, version, bits), prev/next links, tx count.
   - List **first N** txids with simple next/prev pagination.

3. **Transaction (`/tx/{txid}`)**
   - Render: inputs/outputs with value sums, vsize/weight, locktime.
   - **RBF hint** = true if any input `sequence < 0xfffffffe`.

4. **Search (`/search?q=`)**
   - If `^[0-9]+$` → treat as height (resolve via `getblockhash`).
   - If `^[0-9a-f]{64}$` → try block hash; on miss, try txid.
   - Else → **400** with guidance.

**Errors**
- **404** on unknown block/tx.
- **400** on invalid search query.
- **503** if RPC times out or Core is unavailable.

---

## 4) System Architecture (Direct LAN Bind)
```
[ LAN Clients ]  ── HTTP :28765 ─────────▶  [ Explorer Web App ]
                                             Express + Nunjucks
                                             (0.0.0.0:28765, single process)

                                             │ JSON-RPC (loopback HTTP)
                                             ▼
                                     http://127.0.0.1:8332
                                        [ Bitcoin Core ]
                                        server=1, txindex=1, cookie auth
```

**Explorer Web App**
- Single Node.js process using Express, server-rendered HTML.
- In-memory TTL caching via `lru-cache` (tip 3–5s; blocks/tx 5–10m).
- Axios JSON-RPC client with keep-alive agent, 2–3s timeouts, max 4 sockets.
- Read-only operations only.

**Bitcoin Core**
- Source of truth, same box; JSON-RPC on `127.0.0.1:8332`.
- Required flags in `~/.bitcoin/bitcoin.conf`:
  ```ini
  server=1
  rpcbind=127.0.0.1
  rpcallowip=127.0.0.1
  txindex=1
  ```

---

- `getblockchaininfo`
- `getblockcount`
- `getbestblockhash`
- `getmempoolinfo`
- `getblockhash <height>`
- `getblock <hash> 2`  (verbose=2 for decoded tx metadata)
- `getrawtransaction <txid> true`
- `estimatesmartfee <conf_target>`

---

## 6) Configuration & Run
**App environment (`~/bitcoin-explorer/.env`)**
```ini
BITCOIN_RPC_URL=http://127.0.0.1:8332
# Option A: cookie-based auth
BITCOIN_RPC_COOKIE=/home/bitcoin/.bitcoin/.cookie
# Option B: static credentials from bitcoin.conf
BITCOIN_RPC_USER=<rpcuser>
BITCOIN_RPC_PASSWORD=<rpcpassword>
APP_BIND=0.0.0.0
APP_PORT=28765   # unusual high port to avoid conflicts
CACHE_TTL_TIP=5000        # milliseconds
CACHE_TTL_BLOCK=600000
CACHE_TTL_TX=600000
BITCOIN_RPC_TIMEOUT=3000
```

**Run the server**
```bash
# install dependencies
npm install

# start in development (reload via nodemon)
npm run dev

# or run the compiled server
npm run build
npm start
```

**Verify listening & access**
```bash
# on the node
ss -ltnp | grep 28765
# from another LAN device
http://<NODE_LAN_IP>:28765/   # e.g., http://192.168.1.213:28765/
```

---

## 7) Caching (Simple & Safe)
- Keys: `tip:besthash`, `tip:blockcount`, `block:<hash>`, `tx:<txid>`.
- TTLs: tip 3–5s; block/tx 5–10m (configurable via env, defaults above).
- On cache miss → fetch via RPC → cache → render.
- No ZMQ invalidation (keeps dependencies zero).

---

## 8) Security Posture
- Explorer binds to LAN on `0.0.0.0:28765`.
- Bitcoin Core remains **localhost-only** (`127.0.0.1:8332`).
- RPC auth set via env using cookie path or dedicated credentials; no hardcoded secrets in code.
- No outbound calls (no analytics/fonts by default).

> Note: If you later want to restrict LAN access, add firewall rules. For MVP simplicity we keep none here.

---

## 9) Non‑Functional Requirements
- **Performance**: cache hits <150 ms; typical cold misses <800 ms.
- **Reliability**: graceful 404/400/503; no retry storms.
- **Footprint**: RAM well under 200 MB; CPU near idle at rest.
- **Simplicity**: single Node.js process; no DB; no proxy; no runtime caps.

---

## 10) Deliverables
- **Routes**: `/`, `/block/{id}`, `/tx/{txid}`, `/search` via Express.
- **RPC client**: thin Axios wrapper with timeouts & error mapping.
- **Views**: `views/layout.njk`, `views/home.njk`, `views/block.njk`, `views/tx.njk`.
- **Scripts**: `src/server.js` (Express app), `src/rpc.js` (JSON-RPC client), `src/cache.js`.
- **Docs**: `README.md` (quickstart), `RUNBOOK.md` (Core flags/env).

---

## 11) Acceptance Criteria
1. **Home** shows height, best hash, mempool tx count/bytes, fee targets (1/3/6).
2. **Block** by height/hash renders header + tx count and paginated txids.
3. **Tx** renders inputs/outputs, totals, vsize/weight, locktime, RBF hint.
4. **Search** routes correctly; invalid query → **400**.
5. Unknown ids → **404**; RPC timeout/unreachable → **503**.

---

## 12) Setup Notes / Quickstart
1. Ensure Bitcoin Core runs with `txindex=1` and RPC on localhost.
2. Create `.env` as above; run `npm install` to pull dependencies; use `npm run dev` for hot reload or `npm start` for production.
3. Browse from any LAN device to `http://<NODE_LAN_IP>:28765/`.
4. Done. (Extend later with ZMQ, mempool page, or auth if needed.)

---

## 13) Future Extensions (post‑MVP)
- ZMQ `rawblock` to instantly bust caches.
- Mempool page (`getrawmempool true`) and optional SSE.
- Address/descriptor pages (would require light indexing).
- Optional Nginx + auth, or systemd resource caps (if desired later).

## 14) Near-Term Expansion Roadmap
To support the upcoming feature bundle (see `docs/EXPANSION.md`), the next iteration will focus on:
1. **Structured logging** — JSON-formatted logs with request/RPC metadata for easier diagnostics.
2. **ZMQ cache busting** — optional subscriber that invalidates tip/block/tx caches when new `rawblock`/`rawtx` events arrive.
3. **Mempool dashboard** — dedicated route showing live mempool stats, fee histograms, and recent transactions.
4. **Regtest smoke tests** — automated CI workflow that spins up `bitcoind -regtest`, mines blocks, broadcasts tx, and validates explorer behaviour.

These enhancements remain LAN-first and additive; operators can enable them incrementally via new configuration flags documented in `docs/RUNBOOK.md` once implemented.

**Status (current build):** All four items above are now implemented. Structured logs ship via `pino`, `/mempool` exposes live data with optional ZMQ invalidation, and `npm run test:regtest` exercises an automated regtest smoke suite.
