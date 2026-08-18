# Product design

## 1. Purpose

Poolgate Edge is a personal account-pool gateway designed to run on Cloudflare Workers. It accepts an operator-issued `sk-` key, selects one of the operator's Codex/ChatGPT accounts, rewrites the upstream authentication headers, and relays the response as HTTP/SSE or WebSocket traffic.

It is a translation gateway, not a transparent reverse proxy. The only supported upstream response endpoint is pinned to `https://chatgpt.com/backend-api/codex/responses`.

## 2. Product goals

In priority order:

1. Never reuse a refresh token after a successful upstream rotation.
2. Never expose one pooled account's credentials to a caller or another account.
3. Preserve HTTP/SSE and WebSocket behavior expected by Codex clients.
4. Route requests predictably across healthy accounts.
5. Remain usable within the Cloudflare free plan for a personal workload.
6. Keep administration small enough to understand and audit.

## 3. Supported features

### Proxy data plane

- `POST /v1/responses` for the default endpoint.
- `POST /e/:endpoint/v1/responses` for named endpoints.
- WebSocket upgrade on the same paths.
- Forced `stream: true` for HTTP requests.
- Rewriting `Authorization` and `ChatGPT-Account-ID` as one operation.
- Preserving required Codex identity headers.
- Pre-first-byte failover only.
- Per-account concurrency limits and bounded rejection when saturated.

### Routing policies

- `fallback`: first eligible account by configured position.
- `best-quota`: greatest minimum remaining headroom across usage windows.
- `load-balance`: least-in-flight selection with a rotating tie breaker.
- `weighted`: smooth weighted round robin.

### Account lifecycle

- Manual import of a Codex `auth.json` payload.
- Official Codex device-code OAuth from the Admin UI, with bounded encrypted pending state and manual import as the fallback when a workspace disables device authorization.
- Single-flight refresh per account.
- Monotonic credential versions and compare-and-swap commits.
- Passive cooldown after rate limits and transient upstream failures.
- Lightweight current-state probes; no health-check history.

### Administration

- Separate Admin and Proxy hostnames.
- Cloudflare Access protects the entire Admin hostname.
- Cloudflare Access is the sole Admin authentication layer; the application has no login, Passkey, session, or recovery-code flow.
- Account, endpoint, policy-group, and API-key management.
- Explicit policy-member ordering in both create and edit flows; editing must never silently reset fallback priority to account creation order.
- Account import never enables Proxy access implicitly; an administrator must explicitly create a Proxy API key when a client is ready.
- Current account state and quota only.

## 4. Explicit non-goals

- Portable application backups and restores.
- Host-to-host migration tooling.
- Historical request logs, monitoring dashboards, or metrics retention.
- DingTalk, WeCom, or webhook notifications.
- Tamper-evident audit history.
- Application-managed login, Passkey, recovery-code, and admin-session features.
- Docker, reverse-proxy, process-lock, memory-lock, or graceful-drain operations.
- Multi-tenant use, credential resale, or public unauthenticated proxying.

Schema evolution is not an operational feature and remains mandatory. Durable Object migrations must be append-only and guarded by a schema version.

## 5. User-visible configuration

The production deployment has two custom domains pointing to one Worker:

- Admin: for example `admin.poolgate.example.com`.
- Proxy: for example `api.poolgate.example.com`.

The Worker rejects Admin paths on the Proxy hostname and rejects Proxy paths on the Admin hostname. The `workers.dev` and preview URLs must be disabled in production.

Each endpoint resolves to one flat policy group. Each policy group contains ordered account members and optional weights. API keys can be scoped to a set of endpoint names.

## 6. Transport correctness

### HTTP/SSE

The gateway buffers and validates the request before contacting the upstream in the first implementation. The initial body limit is intentionally conservative. A later streaming JSON transformer may raise the limit without multiplying memory usage.

An upstream response becomes committed when its body is returned to the caller. Failover is permitted only before that point.

### WebSocket

The gateway connects and authenticates the upstream WebSocket before accepting the client upgrade. A failed upstream handshake may select another account. Once both sides are upgraded, the selected account is fixed for the lifetime of the connection.

If `x-codex-turn-state` is present on the upgrade, a short-lived mapping pins reconnects to the same account. If it is absent, only connection-level affinity is guaranteed. The gateway must not guess affinity from IP address or API key because concurrent turns would become ambiguous.

## 7. Success criteria

The first production candidate is ready when it demonstrates:

- A real imported account completing HTTP/SSE and WebSocket requests.
- One successful refresh-token rotation with durable journal recovery.
- Two concurrent 401 responses producing one upstream refresh.
- Pre-first-byte failover across two accounts.
- Admin routes unreachable through the Proxy hostname.
- Proxy routes unaffected by Cloudflare Access browser redirects.
- Free-plan CPU, request, storage, and Durable Object duration usage within budget.
