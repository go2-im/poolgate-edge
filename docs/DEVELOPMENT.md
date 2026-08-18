# Development

## Prerequisites

- A supported Node.js release.
- npm.
- A Cloudflare account for remote tests.
- Wrangler authentication only when deploying or using remote resources.

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

`npm run build` performs a Wrangler dry-run bundle and does not deploy.

## Local secrets

Copy `.dev.vars.example` to `.dev.vars` and generate a 32-byte base64 master key. Never commit `.dev.vars`.

Production secrets are set only as an explicit configuration operation:

```sh
npx wrangler secret put MASTER_KEY
```

Normal deployments must use `npm run deploy`. Its `--keep-vars` flag and the matching `keep_vars` configuration preserve dashboard-managed Worker variables; `--strict` rejects conflicting remote changes. `MASTER_KEY` is declared as required, so a deployment fails before upload when the deployed Worker does not have it. Secrets are preserved by Wrangler deployments unless a secret-delete command is explicitly run.

## Production configuration

Before deployment:

1. Replace the example Admin and Proxy hostnames in `wrangler.jsonc`.
2. Add both custom-domain routes.
3. Keep `workers_dev` and preview URLs disabled.
4. Create the R2 rotation-journal bucket.
5. Configure Cloudflare Access for the entire Admin hostname.
6. Set the Access team domain and Admin application AUD tag.
7. Set `MASTER_KEY`.

Production Worker variables are managed in the Cloudflare dashboard, not in `wrangler.jsonc`; the configuration intentionally contains no `vars` section so a code deploy cannot overwrite their values. Use `.dev.vars` locally (copied from `.dev.vars.example`) instead.

Once local Durable Object state contains an account, starting Wrangler enables the same authorized automatic usage polling as production. Use only disposable credentials in local state, or clear the local Wrangler state before testing without upstream egress.
8. Run typecheck, tests, and dry-run build.
9. Verify authentication with `npx wrangler whoami`.
10. Deploy first to a staging Worker and use a non-critical account for the proof. Use `npm run deploy`; do not invoke a raw deploy with flags that disable variable preservation.

## Test layers

- Pure unit tests for parsing, routing policy, encryption format, device-code OAuth responses, and host classification.
- Local Worker tests for Durable Object SQL and Admin APIs.
- Remote tests for Static Assets, R2, WebSocket upgrades, and alarms.
- Manual real-account tests for upstream compatibility; credentials must never be stored in fixtures.
