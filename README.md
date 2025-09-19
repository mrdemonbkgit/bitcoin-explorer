# Slim Bitcoin Explorer (Node.js)

A lightweight Bitcoin block explorer that runs alongside your own Bitcoin Core node. The application is built with Node.js 24.8, Express 5, server-rendered Nunjucks views, and direct JSON-RPC calls—no databases or background indexers.

## Stack
- Node.js 24.8.0 (ES modules)
- Express 5 for HTTP routing
- Nunjucks templates for server-side rendering
- Axios with keep-alive agents for Bitcoin Core JSON-RPC
- lru-cache for in-memory TTL caching
- dotenv + zod for strict environment configuration

## Quickstart
```bash
# install dependencies
npm install

# copy and edit environment configuration
cp docs/env.sample .env
$EDITOR .env

# run with live reload (Node 24+)
npm run dev

# or start the server without file watching
npm start
```

The service listens on the host/port defined in `.env` (`0.0.0.0:28765` by default). Bitcoin Core must be reachable at the configured RPC URL with cookie authentication enabled.

## Environment
Create `.env` in the project root based on `docs/env.sample`:
```
BITCOIN_RPC_URL=http://127.0.0.1:8332

# Option A: cookie-based auth (default when running alongside Bitcoin Core)
BITCOIN_RPC_COOKIE=/home/bitcoin/.bitcoin/.cookie

# Option B: static credentials from bitcoin.conf
BITCOIN_RPC_USER=<rpcuser>
BITCOIN_RPC_PASSWORD=<rpcpassword>

APP_BIND=0.0.0.0
APP_PORT=28765
CACHE_TTL_TIP=5000
CACHE_TTL_BLOCK=600000
CACHE_TTL_TX=600000
BITCOIN_RPC_TIMEOUT=3000
```

## Available Routes
- `/` — Home dashboard with chain tip, mempool status, fee estimates, and search box
- `/block/:id` — Block details by height or hash with paginated txid listing
- `/tx/:txid` — Transaction view with inputs, outputs, totals, and RBF hint
- `/search?q=` — Smart search that routes to the relevant block or transaction

## Project Layout
```
├── AGENTS.md
├── README.md
├── package.json
├── src
│   ├── cache.js
│   ├── config.js
│   ├── errors.js
│   ├── rpc.js
│   ├── server.js
│   └── services
│       └── bitcoinService.js
├── scripts
│   └── build.js
├── views
│   ├── block.njk
│   ├── error.njk
│   ├── home.njk
│   ├── layout.njk
│   └── tx.njk
└── docs
    ├── PRD.md
    ├── RUNBOOK.md
        └── env.sample
```

## Notes
- `npm run build` is a placeholder until a real build/test pipeline is defined.
- Routes render HTML responses only; JSON APIs can be layered later if needed.
- Caches refresh automatically on miss and expire based on the TTL values above.

Refer to `docs/PRD.md` for product requirements and `docs/RUNBOOK.md` for operational guidance.
