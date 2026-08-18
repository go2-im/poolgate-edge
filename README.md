# Poolgate Edge

Poolgate Edge is an edition of [poolgate](https://github.com/go2-im/poolgate) designed to run on Cloudflare Workers®. It exposes a small OpenAI-compatible gateway backed by a pool of Codex/ChatGPT credentials and is intended for personal, low-volume use.

The project is under active migration. See [the product design](docs/DESIGN.md), [architecture](docs/ARCHITECTURE.md), [API contract](docs/API.md), [deployment guide](docs/DEPLOYMENT.md), and [migration plan](docs/MIGRATION.md) before deploying it.

## Target capabilities

- HTTP `POST` plus SSE streaming for `/v1/responses`.
- WebSocket proxying with connection affinity and optional turn affinity.
- `fallback`, `best-quota`, `load-balance`, and `weighted` account selection.
- Pre-first-byte failover, OAuth token refresh, cooldown, and bounded per-account concurrency.
- A small administration UI protected by Cloudflare Access.
- Strongly consistent state in one SQLite-backed Durable Object.

Backups, historical monitoring, notifications, tamper-evident audit logs, and host-level operations are intentionally out of scope.

## Development status

The first vertical slice is implemented locally: host isolation, cryptographic Cloudflare Access validation, Durable Object schema initialization, account import/edit/disable, current quota polling with bounded alarms, flat policy-group and endpoint management, explicit Proxy API-key management, HTTP/SSE proxying, WebSocket proxying, OAuth refresh, and a durable rotation journal. Cloud integration and real-account transport tests remain pending.

## Trademark notice

Cloudflare®, Cloudflare Workers®, and Durable Objects™ are trademarks of Cloudflare, Inc. This independent project is not affiliated with or endorsed by Cloudflare, Inc.

## License

MIT
