# Architecture

## 1. Deployment topology

```text
admin.example.com ─ Cloudflare Access ─┐
                                      ├─ Worker ─ PoolCoordinator Durable Object
api.example.com ──────────────────────┘                  │
                                                        ├─ SQLite storage
                                                        ├─ R2 rotation journal
                                                        └─ chatgpt.com / auth.openai.com

Admin static files ─ Workers Static Assets
```

One Worker script is attached to both custom domains. One named Durable Object, `pool:primary`, is the authority for a personal deployment.

## 2. Worker responsibilities

The outer Worker must stay deliberately thin so it remains below the free plan's CPU limit:

- Classify the request by exact hostname.
- Reject cross-surface paths.
- Forward Admin API and Proxy traffic to `PoolCoordinator`.
- Serve Admin UI assets only on the Admin hostname.
- Add common response security headers.

It does not parse large proxy bodies, decrypt credentials, select accounts, or own WebSocket state.

## 3. PoolCoordinator responsibilities

`PoolCoordinator` replaces the original Go process, SQLite connection, credential locks, routing cursors, and scheduler.

It owns:

- Schema initialization and migration.
- Encrypted account credentials.
- API keys, endpoints, policy groups, and members.
- Current health, cooldown, usage, and concurrency state.
- Non-destructive administrator enable/disable state, independent from upstream health state.
- OAuth refresh single-flight and credential-version CAS.
- HTTP/SSE upstream fetches and response streams.
- Both sides of each WebSocket proxy connection.
- Turn-affinity mappings.
- A single Durable Object alarm for due health work.

Critical state is stored in SQLite. In-memory state is limited to active connection counters, selection cursors, weighted accumulators, and in-progress refresh promises. Eviction is safe because eviction also terminates active streams; the next instance reconstructs durable state.

## 4. Why not D1

D1 would provide SQL storage but not the single coordination boundary required for refresh single-flight, in-flight accounting, smooth weighted selection, turn affinity, alarms, and WebSocket ownership. Combining D1 with several coordinator objects would create two authorities and more failure modes.

A single SQLite-backed Durable Object is intentionally accepted as a low-volume singleton. If throughput ever exceeds one object's capacity, the design can shard by pool ID without changing the external API.

## 5. Request flows

### HTTP/SSE

1. Worker verifies the Proxy hostname and forwards the request to the named object.
2. Object hashes and validates the inbound bearer key.
3. Object resolves endpoint, policy group, members, and current account state.
4. Object selects and acquires an account concurrency slot.
5. Object decrypts the credentials and constructs a pinned upstream request.
6. On a pre-body 401, it refreshes once and retries the same account.
7. On a pre-body 403, 408, 425, 429, selected 5xx, or network failure, it cools the account and tries another member. A repeated 401 after one refresh marks the credential expired.
8. On commitment, it streams the upstream body unchanged.
9. Completion or cancellation releases the account slot.

### WebSocket

1. Steps 1–5 are the same as HTTP.
2. Object sends an outbound `Upgrade: websocket` request with rewritten headers.
3. A failed handshake can refresh or fail over.
4. On success, the object accepts the client side and relays message, close, and error events in both directions.
5. Cleanup is idempotent and releases the account slot once.

Outbound WebSockets prevent hibernation. This is a known cost tradeoff and is why all connections share one personal-pool object rather than creating an object per connection.

The upstream handshake completes before the client receives `101`. Non-retryable client errors stop failover, while retryable account or transport failures may select another member. Once committed, send failures and either peer closing trigger idempotent two-sided cleanup and release the account's concurrency slot.

## 6. Storage model

The current schema contains:

- `schema_migrations`
- `accounts`
- `api_keys`
- `policy_groups`
- `group_members`
- `endpoints`
- `usage_current`
- `turn_affinity`

There are no request-log, health-history, notification, audit-log, session, WebAuthn, backup, or restore tables.

Secret columns are encrypted with AES-256-GCM. The encryption key is a Worker secret and is never committed to Git. API keys are stored only as SHA-256 hashes plus a short display hint.

API-key IP allowlists are stored as bounded JSON arrays. The outer Worker replaces the internal client-IP header from Cloudflare's `CF-Connecting-IP`; the coordinator never trusts a client-supplied internal header. Empty allowlists preserve unrestricted behavior for existing keys.

## 7. Rotation journal

An OAuth issuer may invalidate an old refresh token when it returns a new one. Losing the new token between the upstream response and SQLite commit can permanently break the account.

The refresh sequence is therefore:

1. Fetch new tokens from the pinned issuer.
2. Encrypt them.
3. Persist a versioned pending record in R2, retrying the idempotent write up to three times before permitting any SQLite change.
4. CAS the SQLite account from credential version N to N+1.
5. Remove the R2 record.

Before any refresh, the object reconciles a pending record. A record applies only when SQLite is still at its base version; an already-applied record is deleted, and an ambiguous generation fails closed. Journal ciphertext is authenticated by AES-GCM decryption before reconciliation commits it.

Failure semantics are asymmetric by design: a failed journal write prevents the SQLite CAS; a failed SQLite CAS leaves the journal for recovery; and a failed journal deletion after a successful CAS does not invalidate the newly committed credentials. Only an explicit OAuth `invalid_grant` makes an account terminally expired. Network, R2, SQLite, and malformed upstream failures cause a temporary cooldown instead.

## 8. Scheduling

The object maintains one alarm for the earliest account probe or turn-affinity expiry. Healthy accounts are polled every 15 minutes through the pinned zero-token usage endpoint. Each alarm processes at most three due accounts, writes only `usage_current` and account state, then schedules the next deadline. Cooldown gates, upstream `Retry-After`, and exhausted-window reset times prevent early re-probes. Alarm handlers are idempotent because delivery is at least once.

## 9. Static assets

Static Assets are configured with Worker-first routing. This prevents assets from being served on the Proxy hostname before host isolation executes. The Worker calls the `ASSETS` binding only after classifying the request as Admin traffic.
