# API contract

This document describes the first migration slice. Unless noted otherwise, responses are JSON and include `Cache-Control: no-store`.

## Host separation

The same Worker serves two exact hostnames:

- Admin hostname: static UI and `/admin/api/*` only. Cloudflare Access must protect the whole hostname.
- Proxy hostname: `/healthz`, `/v1/responses`, and `/e/:endpoint/v1/responses` only. It must not be placed behind the interactive Admin Access policy.

Requests for any other hostname receive `421`. Admin routes on the Proxy hostname and Proxy routes on the Admin hostname receive `404`.

## Error shape

```json
{
  "error": {
    "type": "machine_readable_code",
    "message": "secret-free explanation"
  }
}
```

No response includes pooled access, refresh, or ID tokens.

## Admin API

Every Admin request is authenticated by validating the Cloudflare Access application JWT. Browser mutations (`POST`, `PATCH`, and `DELETE`) must also include an `Origin` exactly matching the Admin origin.

### `GET /admin/api/identity`

Returns the identity from the verified Access application token. It exposes only `email` and `subject`; it does not return the JWT or Access cookies.

### `GET /admin/api/client-config`

Returns the configured HTTPS Proxy base URL without credentials. The Admin UI combines it with a selected endpoint and an optionally pasted API key entirely in browser memory. The pasted key is not included in any request and is cleared when requested or when the page is left.

### `GET /admin/api/status`

Returns the schema version and current resource counts.

```json
{
  "service": "poolgate-edge",
  "schemaVersion": 4,
  "accounts": 1,
  "endpoints": 1,
  "apiKeys": 0
}
```

### `GET /admin/api/accounts`

Returns non-secret account metadata and the latest current usage snapshot. Ciphertext fields are removed rather than redacted. `enabled` reports the administrator-controlled routing state. `usage` is `null` until the first successful poll; otherwise it contains `planType`, generic percentage windows, `capturedAt`, and the minimum remaining `headroom` used by `best-quota`.

### `POST /admin/api/accounts/:id/probe`

Immediately performs the same zero-token usage check used by the alarm scheduler. It sends the decrypted account access token and account ID only to the pinned `https://chatgpt.com/backend-api/wham/usage` endpoint. A successful response replaces `usage_current` and returns the new non-secret snapshot.

The endpoint may refresh credentials once after an upstream `401`. A `429` honors `Retry-After`; transient failures defer the next automatic attempt without creating history records.

### `POST /admin/api/accounts/import`

Imports a Codex `auth.json` document. The body is limited to 1 MiB.

```json
{
  "label": "personal",
  "content": "{\"tokens\":{...}}"
}
```

The account is added to the default fallback group. Importing an account does not create or return a Proxy API key:

```json
{
  "account": {
    "id": "acct_...",
    "accountId": "...",
    "label": "personal",
    "state": "ok"
  }
}
```

Re-importing the same upstream account replaces its encrypted credentials and increments its credential version.

### `PATCH /admin/api/accounts/:id`

Updates non-secret account settings. `label` is at most 80 characters. `concurrencyCap` is an integer from 0 to 100; zero means unlimited. `enabled` is an optional boolean.

```json
{
  "label": "Personal Pro",
  "concurrencyCap": 2,
  "enabled": true
}
```

Disabling an account immediately excludes it from new routing selections, automatic usage alarms, and manual probes without deleting credentials, usage, or policy membership. Existing committed SSE streams and WebSocket connections continue until they close. Re-enabling sets health state to `unknown`, clears stale cooldown, and schedules an immediate usage check.

### `GET /admin/api/policy-groups`

Lists flat routing policies with their ordered `memberAccountIds` and `memberWeights`. Supported strategies are `fallback`, `best-quota`, `load-balance`, and `weighted`.

### `POST /admin/api/policy-groups`

Creates a reusable policy group. Account IDs must refer to imported accounts, and weights are integers from 1 to 1,000,000.

```json
{
  "name": "Balanced Pro",
  "strategy": "weighted",
  "memberAccountIds": ["acct_...", "acct_..."],
  "memberWeights": { "acct_...": 2 }
}
```

### `PATCH /admin/api/policy-groups/:id`

Updates the name, strategy, ordered membership, or weights. Array order is authoritative and defines fallback priority. The Admin UI preserves the returned order and provides explicit up/down controls. Replacing or reordering membership changes routing configuration only; it does not delete accounts or credentials.

### `GET /admin/api/endpoints`

Lists endpoint names and their bound policy groups.

### `POST /admin/api/endpoints`

Creates a named endpoint with `{ "name": "team-a", "groupId": "group_..." }`. Names use letters, digits, `.`, `_`, and `-`, with a maximum length of 64.

### `PATCH /admin/api/endpoints/:name`

Rebinds an existing endpoint using `{ "groupId": "group_..." }`. Endpoint names remain stable so API-key scopes and client URLs do not change implicitly.

### `GET /admin/api/api-keys`

Lists non-secret key metadata: ID, label, last-eight-character hint, endpoint scope, IP allowlist, expiry, creation time, and monotonically increasing `keyVersion`.

### `POST /admin/api/api-keys`

Explicitly creates a Proxy API key. This is a separate administrator action and is never triggered by account import.

```json
{
  "label": "Local Codex",
  "endpoints": ["default"],
  "ipAllowlist": ["203.0.113.7", "2001:db8::/32"],
  "expiresInDays": 90
}
```

`endpoints: []` means all endpoints. `ipAllowlist: []` means any client IP; otherwise it accepts up to 64 IPv4, IPv6, or CIDR entries. The Admin UI also supports selecting one endpoint when creating a key. `expiresInDays` may be omitted for no automatic expiry. The plaintext `apiKey` is returned only in this creation response; only its SHA-256 hash and display hint are stored.

### `PATCH /admin/api/api-keys/:id`

Updates non-secret key metadata without changing the stored key hash or `keyVersion`:

```json
{
  "label": "Laptop Codex",
  "endpoints": ["default"],
  "ipAllowlist": ["203.0.113.7/32"],
  "expiresInDays": 90
}
```

Fields are optional, but at least one must be supplied. `endpoints: []` grants all current and future endpoints, while `ipAllowlist: []` clears the IP restriction. `expiresInDays` resets expiry relative to the update time; `null` clears expiry. Omitting a field preserves its current value. The response contains metadata only and can never return the current key plaintext.

### `POST /admin/api/api-keys/:id/regenerate`

Atomically replaces the stored hash with a newly generated Proxy API key and invalidates the previous value. The endpoint never returns or reconstructs the existing key plaintext. Only the newly generated plaintext is returned, once, in the successful regeneration response. The request must include the version obtained from the list API:

```json
{ "expectedVersion": 1 }
```

Regeneration uses a compare-and-swap update against `expectedVersion`. If two regeneration requests race from the same UI state, only one succeeds; a stale request receives `409` without receiving its generated candidate secret.

If the successful response is lost, the new plaintext cannot be retrieved. Regenerate the key again.

### `DELETE /admin/api/api-keys/:id`

Revokes the selected Proxy key for new requests and reconnects. Already-committed SSE streams and established WebSocket connections continue until they close; the gateway does not interrupt committed transport sessions.

## Proxy API

### Authentication

Send the Poolgate API key, not an upstream account token:

```http
Authorization: Bearer sk-pg-...
```

API keys are created explicitly in the Access-protected Admin UI and stored as SHA-256 hashes. An empty endpoint scope means all endpoints.

When an API key has an IP allowlist, the gateway matches it against Cloudflare's `CF-Connecting-IP`. The outer Worker removes any inbound `x-poolgate-client-ip` value and creates that internal header only from a syntactically valid Cloudflare address. A missing or non-matching address receives `403 api_key_ip_denied`.

### `POST /v1/responses`

Uses the `default` endpoint. The request body must be a JSON object and is limited by `MAX_REQUEST_BODY_BYTES`. The gateway sets `stream: true`, rewrites both upstream authentication headers, and streams the upstream SSE body.

### `POST /e/:endpoint/v1/responses`

Identical behavior using a named endpoint. Endpoint names contain only letters, digits, `.`, `_`, and `-`, with a maximum length of 64.

### WebSocket upgrade

Send a `GET` WebSocket upgrade to either response path with the same bearer key. The gateway authenticates and completes the upstream handshake before returning `101` to the client. It then relays text and binary messages in both directions.

The account is fixed for the connection lifetime. `x-codex-turn-state`, when supplied or returned by the upstream, creates a 10-minute reconnect affinity entry. Entries are hashed, expired by an alarm, and capped at 4,096 records. Individual messages are bounded by `MAX_REQUEST_BODY_BYTES`.

The Worker supplies the Codex WebSocket beta header when the client omits it, normalizes reserved close codes, caps close reasons to the protocol limit, and closes both peers if a relay send fails.

### `GET /healthz`

Returns outer-Worker liveness without contacting the Durable Object or upstream:

```json
{ "ok": true, "service": "poolgate-edge" }
```

### `GET /readyz`

Returns `200` with `{ "ready": true }` when at least one configured endpoint has an eligible account. Otherwise it returns `503` with `{ "ready": false, "reason": "no_eligible_route" }`. This endpoint reads current Durable Object state but does not contact the upstream or expose account identifiers, counts, or credentials.

## Retry boundary

The gateway may refresh or select another account only before returning upstream headers/body or accepting a WebSocket. Pre-commit `401`, `403`, `408`, `425`, `429`, selected `5xx` responses, and transport failures can drive refresh, cooldown, or failover. It never resumes or fails over a committed SSE stream or established socket.

When healthy members exist but every member is at its configured concurrency limit, HTTP and WebSocket handshakes fail fast with `429`, error type `backpressure`, and `Retry-After: 1`. If no member is eligible, the response is `503` with error type `no_eligible_account`.
