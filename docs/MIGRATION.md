# Migration plan

## Scope baseline

The source of truth for behavior is `go2-im/poolgate`. Poolgate Edge ports the data plane and a reduced management plane; it does not attempt line-for-line compatibility with local operations.

## Phase 0 — platform proof

Status: implemented locally; Cloudflare integration validation pending.

- Worker host isolation.
- SQLite-backed `PoolCoordinator` Durable Object.
- Static Assets wiring.
- Schema and secret encryption primitives.
- Manual account import and default endpoint initialization.
- One HTTP/SSE request through one real account.
- One WebSocket request through one real account.

Exit gate: Cloudflare egress reaches the pinned upstream, both transports stream correctly, and the free-plan CPU limit is not exceeded by the outer Worker.

## Phase 1 — routing vertical slice

- API-key hashing, expiry, and endpoint scope.
- Flat endpoint and policy-group storage.
- Four selection policies.
- In-flight accounting and concurrency caps.
- Strict pre-first-byte failover.
- Secret-free error format compatible with the original gateway.

Exit gate: deterministic tests cover selection and two-account failover.

## Phase 2 — credential correctness

Status: refresh single-flight, version CAS, journal validation, and injected write/commit/cleanup failure tests are implemented locally. Remote R2 interruption and real rotating-token tests remain pending.

- Pinned OAuth refresh endpoint and client ID.
- Per-account refresh promise coalescing.
- Authoritative credential re-read.
- R2 pending-rotation journal.
- Credential-version CAS and startup/request reconciliation.
- Manual-paste OAuth flow adapted from the latest upstream implementation.

Exit gate: concurrent 401s cause one refresh, and injected failures at every journal/commit boundary recover without reusing the old token.

## Phase 3 — WebSocket hardening

Status: lifecycle and protocol helpers implemented locally; real upstream and long-duration integration tests pending.

- Upstream handshake refresh and failover.
- Bidirectional binary/text relay.
- Idempotent cleanup.
- Connection affinity.
- Short-lived `x-codex-turn-state` affinity.
- Cancellation, size, and long-duration tests.

Exit gate: repeated connect, reconnect, close, and injected upstream failure tests leave all in-flight counters at zero.

## Phase 4 — reduced Admin UI

- Reuse the existing React visual language where practical.
- Cloudflare Access identity display.
- Account import, non-secret editing, and non-destructive disable/enable. Account deletion remains pending explicit destructive-action design and confirmation.
- Policy group create/edit with stable member ordering, endpoint create/rebind, and API-key create/edit/regenerate/revoke with optional IP/CIDR restrictions are implemented locally. Destructive group/endpoint deletion remains intentionally deferred.
- Current state and quota display only.
- Client configuration generator.

Exit gate: no credential plaintext is returned after its one-time import/create response.

## Phase 5 — health and production readiness

Status: bounded alarm scheduling, current usage polling, 401 refresh, cooldown gating, quota reset recovery, and manual Admin checks are implemented locally; remote alarm delivery and real-account validation remain pending.

- Durable Object alarm scheduler (implemented locally; maximum three accounts per alarm).
- Current usage polling and auth checks (implemented locally through the pinned usage endpoint).
- Cooldown and quota recovery (implemented locally).
- Access JWT validation (implemented locally; remote key-rotation validation pending).
- Custom-domain production configuration.
- Free-tier budget documentation and alerts.
- Remote integration tests and rollback instructions.

Exit gate: staging survives a multi-day personal workload and a production deployment can be rolled back with Wrangler versions.

## Data migration policy

There is no automatic SQLite migration from the Go edition. The first release starts with a new Durable Object and requires credentials to be re-imported. Endpoints and policies may be recreated through the Admin UI.

This avoids transferring local master keys, old operational tables, request history, backup metadata, and platform-specific state into the new trust boundary.
