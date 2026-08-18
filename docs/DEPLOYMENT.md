# Cloudflare deployment

This guide targets a personal, low-volume deployment. It deliberately keeps the Admin UI and Proxy in one Worker while giving them different security policies.

## 1. Prerequisites

- A Cloudflare account with Workers, Durable Objects, R2, and Access available.
- A zone with two hostnames, for example `admin.example.com` and `api.example.com`.
- Node.js and npm for local development.
- Wrangler authenticated to the intended Cloudflare account.

The design can begin on the free plan, but it is not “unlimited free.” WebSocket duration, Durable Object requests/duration, Worker requests/CPU, and R2 operations all consume platform quotas. Review current Cloudflare pricing before production use.

## 2. Configure the repository

Edit `wrangler.jsonc`:

1. Replace `ADMIN_HOST` and `PROXY_HOST` with the two exact production hostnames.
2. Keep `workers_dev` and `preview_urls` disabled for production.
3. Keep the pinned upstream and OAuth values unchanged.
4. Add custom-domain routes after the hostnames are known:

```jsonc
"routes": [
  { "pattern": "admin.example.com", "custom_domain": true },
  { "pattern": "api.example.com", "custom_domain": true }
]
```

Do not use one hostname for both surfaces. The Worker intentionally fails closed if the configured hostnames are equal.

## 3. Create storage and secrets

Create the R2 bucket once:

```sh
npx wrangler r2 bucket create poolgate-edge-rotation-journal
```

Generate a random 32-byte key, encode it as base64, and store it as a Worker secret:

```sh
npx wrangler secret put MASTER_KEY
```

Never commit the decoded key, its base64 form, `.dev.vars`, exported credentials, or a plaintext `auth.json`.

The Durable Object namespace and its SQLite storage are created by the `v1` Wrangler migration during deployment.

## 4. Configure Cloudflare Access

Create an Access self-hosted application covering the entire Admin hostname. Permit only the operator identities that should manage pooled credentials.

Copy the application Audience (AUD) tag and set these Worker variables before deployment:

```json
"ACCESS_TEAM_DOMAIN": "https://your-team.cloudflareaccess.com",
"ACCESS_AUD": "your-admin-application-aud-tag"
```

`ACCESS_TEAM_DOMAIN` must be the HTTPS Cloudflare Access team origin without a path. The Worker retrieves the rotating signing keys from its `/cdn-cgi/access/certs` endpoint.

Do not attach that interactive Access application to the Proxy hostname. Proxy clients authenticate with the Poolgate API key; an Access login redirect would break HTTP/SSE and WebSocket clients.

This is one Worker deployment, not two application deployments:

| Host | Access policy | Application authentication |
| --- | --- | --- |
| Admin | Required for the whole host | Access identity assertion |
| Proxy | No interactive Admin policy | `Authorization: Bearer sk-pg-...` |

The Worker verifies the assertion signature, issuer, application audience, time claims, and application-token type. Alternate routes to the Admin surface must still stay disabled as an independent host-isolation boundary.

## 5. Verify and deploy

```sh
npm install
npm run typecheck
npm test
npm run build
npx wrangler deploy
```

The build command is a dry run. It must show the `POOL`, `ROTATION_JOURNAL`, and `ASSETS` bindings before a real deployment.

After deployment:

1. Check `/healthz` on the Proxy hostname for outer Worker liveness.
2. Check `/readyz` for a secret-free confirmation that at least one endpoint has an eligible account.
3. Confirm an unknown hostname and cross-surface route fail closed.
4. Open the Admin hostname through Access and add one account using device-code sign-in or manual `auth.json` import.
5. Leave the Proxy key list empty while migration validation is incomplete; imported accounts alone do not enable client access.
6. When a test client is ready, explicitly create a scoped Proxy API key and save its one-time plaintext value.
7. Send one HTTP/SSE request through the Proxy hostname.
8. Send one WebSocket request and confirm both directions close cleanly.
9. Exercise one token refresh in staging before relying on the account.

## 6. Local development

Copy `.dev.vars.example` to `.dev.vars` and set a disposable development `MASTER_KEY`. Change `ENVIRONMENT` to `development` and `ADMIN_AUTH_MODE` to `dev` only in a local Wrangler environment; never deploy that combination to production.

See `docs/DEVELOPMENT.md` for the test workflow and `docs/SECURITY.md` for the remaining release gates.
