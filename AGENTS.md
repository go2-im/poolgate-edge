# Poolgate Edge repository workflow

## Main branch

- `main` is PR-only. Never commit to it or push to it directly.
- All changes, including documentation and configuration changes, use a dedicated feature branch and worktree. Do not force-push or delete `main`.
- Keep commits focused. Run the relevant verification before opening a PR; for TypeScript changes this normally includes `npm run typecheck` and `npm test` from the worktree's `main` project directory.

## Start every change

The repository uses a bare Git directory with worktrees. The `main/` worktree tracks `origin/main`; feature worktrees are siblings of it.

1. Inspect and synchronize Git state:

   ```sh
   git -C main status -sb
   git -C main fetch origin --prune
   git -C main status -sb
   ```

2. Only when the `main/` worktree is clean and no local commits are pending, synchronize it without rewriting history:

   ```sh
   git -C main pull --ff-only origin main
   ```

3. Create a new worktree and branch from the synchronized remote main:

   ```sh
   git -C main worktree add ../<worktree-name> -b <type>/<short-slug> origin/main
   ```

   Use a descriptive branch type such as `feat/`, `fix/`, `docs/`, `chore/`, or `refactor/`. Make and test all changes in that new worktree, never in `main/`.

## Commit, push, and PR

1. Review only the intended files, stage them explicitly, and create a conventional commit from the feature worktree.
2. Push the feature branch without force-pushing:

   ```sh
   git push -u origin <type>/<short-slug>
   ```

3. Create a PR targeting `main`. For GitHub API operations, read `GITHUB_TOKEN_WITH_GO2_IM` only from the environment, send it in an Authorization header, and never print, persist, or place it in command output. Include the change summary and verification results in the PR body.
4. Merge through the PR after checks and review requirements pass. Then remove the merged feature worktree and prune stale remote references.

## GitHub branch protection

`main` must enforce pull-request-only changes, apply the rule to administrators, require linear history and resolved review conversations, and disallow force pushes and deletion. Do not weaken or bypass these protections.

Use `GITHUB_TOKEN_WITH_GO2_IM` with the GitHub REST API for protection or PR administration. The token must have repository Administration permission for branch-protection changes. If the API returns `Resource not accessible by personal access token`, stop and request a token with that permission; do not work around the restriction.

## Cloudflare deployment and secrets

- Treat Cloudflare Worker secrets, dashboard environment variables, `.dev.vars`, and deployment bindings as protected configuration.
- A normal code deployment must not reset, replace, delete, or bulk-import Worker secrets or environment variables.
- Use `npm run deploy` for a normal production deployment. It preserves dashboard-managed variables and validates the required production secret before upload; do not replace it with an unsafe raw Wrangler command.
- Do not run `wrangler secret put`, `wrangler secret delete`, `wrangler secret bulk`, or any Cloudflare configuration API/binding update unless the user explicitly requests that exact configuration change.
- Do not add, remove, or alter `vars`, secrets, bindings, routes, or environment sections in Wrangler configuration as an incidental part of a code deployment. Review deployment configuration separately before any deploy.
