# Security model

## 1. Protected assets

- Codex access, refresh, and ID tokens.
- Inbound Poolgate API keys.
- Account identifiers and current quota information.
- Admin configuration.
- Turn-affinity tokens.

## 2. Trust boundaries

Cloudflare Access authenticates the human operator before Admin requests reach the Worker. Poolgate API keys authenticate automated clients on the Proxy hostname. The Durable Object and its bindings are trusted application infrastructure. `chatgpt.com` and `auth.openai.com` are pinned external services.

The browser-facing Admin application never receives pooled account tokens after import.

Automated current-usage polling is explicitly limited to `https://chatgpt.com/backend-api/wham/usage`. It sends the same account bearer token and `ChatGPT-Account-ID` pair required by normal Proxy traffic. Responses are bounded to 1 MiB and only the latest non-secret plan/window snapshot is stored; no usage history is retained.

## 3. Mandatory controls

- Exact-host routing with fail-closed unknown hosts.
- `workers.dev` and preview URLs disabled in production.
- Admin routes rejected on the Proxy hostname.
- Proxy routes rejected on the Admin hostname.
- Cloudflare Access configured for the entire Admin hostname.
- Application secrets stored with Wrangler secrets, never `vars`.
- `Authorization` and `ChatGPT-Account-ID` rewritten together.
- Pinned upstream hosts and HTTPS only.
- Usage alarms process at most three due accounts per delivery and never probe before a stored cooldown, `Retry-After`, or exhausted-window reset gate.
- API keys stored as hashes and compared without plaintext persistence.
- Optional per-key IPv4/IPv6/CIDR allowlists are enforced against the Cloudflare-provided client address. Configured rules fail closed when the address is missing or invalid.
- Account import never creates a Proxy API key; Proxy access requires a separate explicit Admin action.
- Disabling an account is non-destructive but fail-closed for new work: routing, alarms, and manual probes all exclude it until explicitly re-enabled.
- Existing Proxy API key plaintext is irretrievable. Regeneration atomically replaces its hash and returns only the newly generated plaintext once.
- API key label, endpoint scope, and expiry can be edited without reading or replacing the key hash; metadata edits do not increase `keyVersion`.
- The client-configuration generator receives only the Proxy base URL from the server. Any key pasted into it remains browser-local and is never persisted or submitted.
- Field encryption for pooled tokens before Durable Object or R2 storage.
- Rotation journal entries must name the expected account, pass structural/version validation, and contain ciphertext that passes AES-GCM authentication before recovery can update SQLite.
- Bounded request bodies and JSON input validation.
- Secret-free errors and logs.
- No caching on `/admin/api/*` or `/v1/*`.

## 4. Access assumptions

Access is the enforcement point for the Admin hostname, and the Worker independently validates the `Cf-Access-Jwt-Assertion` application token. Validation pins RS256, the configured `https://<team>.cloudflareaccess.com` issuer, the Admin application's AUD tag, required time claims, and the `app` token type. Signing keys are loaded from the issuer's Access certs endpoint and cached in memory; normal Access key rotation is handled by `kid` lookup.

Production deployment also disables alternate Worker URLs and rejects Admin paths on every non-Admin host. Admin mutations require an exact same-origin `Origin` header before they are forwarded to the Durable Object.

## 5. Credential encryption

The application uses AES-256-GCM with a random 96-bit IV for each field. Ciphertext values are versioned so a future key or format migration can coexist with the current format. The master key is supplied as a base64-encoded 32-byte Worker secret named `MASTER_KEY`.

Cloudflare also encrypts Durable Object storage at rest, but application encryption limits exposure through accidental SQL exports or storage inspection.

## 6. WebSocket considerations

- Authenticate and select an account before returning status 101.
- Do not accept client-controlled upstream URLs or authentication headers.
- Relay only message payloads; do not synthesize protocol messages that could alter Codex semantics.
- Cap message size at the platform and application limits.
- Release in-flight capacity on close, error, or failed handshake.
- Treat turn-state values as secrets and expire them quickly.

Turn-state values are SHA-256 hashed before storage, expire after 10 minutes, and are capped at 4,096 records per coordinator.

## 7. Remaining security work

- Add constant-time byte comparison where a lookup alone is not sufficient.
- Complete adversarial tests for header smuggling, host confusion, oversized bodies, and WebSocket cleanup.
- Perform a real-account egress and upstream anomaly test before production use.
