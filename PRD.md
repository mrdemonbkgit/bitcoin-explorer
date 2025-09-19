# Slim Bitcoin Explorer — PRD (Basis-Only, LAN Direct Bind)

## 1) Summary
A **local-LAN accessible**, read-only Bitcoin block explorer that runs as a single web process and talks directly to **Bitcoin Core JSON-RPC** on the same machine. No database, no background indexers, no proxy (Nginx), and no runtime resource boundaries. It binds directly to an **unusual high port** to avoid conflicts.

**Primary outcome:** Fast, reliable pages for **Home**, **Block**, **Transaction**, and **Search**, with minimal system impact and simple deployment.

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
                                             FastAPI + Jinja2
                                             (0.0.0.0:28765, 1 worker)

                                             │ JSON-RPC (loopback HTTP)
                                             ▼
                                     http://127.0.0.1:8332
                                        [ Bitcoin Core ]
                                        server=1, txindex=1, cookie auth
```

**Explorer Web App**
- Single process, 1 worker, server-rendered HTML (Jinja2).
- In-memory cache (tip 3–5s; blocks/tx 5–10m).
- Tiny JSON-RPC client (keep‑alive session, 2–3s timeouts, pool size 2–4).
- Read‑only operations only.

**Bitcoin Core**
- Source of truth, same box; JSON‑RPC on `127.0.0.1:8332`.
- Required flags in `~/.bitcoin/bitcoin.conf`:
  ```ini
  server=1
  rpcbind=127.0.0.1
  rpcallowip=127.0.0.1
  txindex=1
  ```

---

## 5) RPCs Used (only these)
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
BITCOIN_RPC_COOKIE=/home/bitcoin/.bitcoin/.cookie
APP_BIND=0.0.0.0
APP_PORT=28765   # unusual high port to avoid conflicts
```

**Run the server**
```bash
# from the explorer user inside the project
uvicorn app.app:app --host $APP_BIND --port $APP_PORT --workers 1
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
- TTLs: tip 3–5s; block/tx 5–10m.
- On cache miss → fetch via RPC → cache → render.
- No ZMQ invalidation (keeps dependencies zero).

---

## 8) Security Posture
- Explorer binds to LAN on `0.0.0.0:28765`.
- Bitcoin Core remains **localhost-only** (`127.0.0.1:8332`).
- Cookie auth path provided via env; no hardcoded creds.
- No outbound calls (no analytics/fonts by default).

> Note: If you later want to restrict LAN access, add firewall rules. For MVP simplicity we keep none here.

---

## 9) Non‑Functional Requirements
- **Performance**: cache hits <150 ms; typical cold misses <800 ms.
- **Reliability**: graceful 404/400/503; no retry storms.
- **Footprint**: RAM well under 200 MB; CPU near idle at rest.
- **Simplicity**: single process; no DB; no proxy; no runtime caps.

---

## 10) Deliverables
- **Routes**: `/`, `/block/{id}`, `/tx/{txid}`, `/search`.
- **RPC client**: tiny, with timeouts & error mapping.
- **Templates**: `base.html`, `home.html`, `block.html`, `tx.html`.
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
2. Create `.env` as above; install app deps; start uvicorn.
3. Browse from any LAN device to `http://<NODE_LAN_IP>:28765/`.
4. Done. (Extend later with ZMQ, mempool page, or auth if needed.)

---

## 13) Future Extensions (post‑MVP)
- ZMQ `rawblock` to instantly bust caches.
- Mempool page (`getrawmempool true`) and optional SSE.
- Address/descriptor pages (would require light indexing).
- Optional Nginx + auth, or systemd resource caps (if desired later).
