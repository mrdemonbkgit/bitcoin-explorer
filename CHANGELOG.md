# Changelog

## Unreleased
- Rolled out the `/api/v1` JSON endpoints alongside existing SSR pages, keeping shared services as the single source of truth.
- Extended the regtest smoke script to assert API responses for tip, block, transaction, and mempool flows.
- Documented a curl-based API smoke checklist to guide manual verification during rollout.
- Added an optional Prometheus metrics exporter (`/metrics`) with HTTP/RPC/cache/ZMQ instrumentation, documentation updates, and regtest coverage.
- Laid out the WebSocket notifications plan and implemented LAN-only WebSocket push updates with client hydration, configuration flags, metrics/logging, and optional regtest smoke coverage.
- Added a SQLite-backed address/xpub explorer behind `FEATURE_ADDRESS_EXPLORER`, including indexer architecture, SSR/API routes, and docs/tests for configuration and usage.
