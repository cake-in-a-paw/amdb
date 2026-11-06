# 0005. Railway deployment: production only, as code

- **Status:** accepted (2026-11-05, after the first deploy's smoke test)
- **Date:** 2026-11-03

## Context

The web app (plan 2) is the first thing users can reach, so AMDB needs a host. The owner's other
project, rmd, runs on Railway and defines it in code (rmd ADR 0008), at `amdb.ty-pe.com` under a
domain whose DNS is on Cloudflare. ADR 0004 has the API serve the built SPA from one origin.
There are no users yet, and the Railway bill has a small ceiling. Railway's legacy config files
stop being read on 2026-12-01.

## Decision

- The Railway project is defined in `.railway/railway.ts` (the `railway` SDK, pinned) and changed
  with `railway config plan` and `railway config apply`. Secrets stay in Railway: the file marks
  them, and `ADMIN_EMAILS`, `preserve()`. The repo is public, so no address goes in it.
- One environment, `production`, deploys `main` and waits for the commit's GitHub checks (CI).
- One service, `app`, builds the web app (`pnpm --filter @amdb/web build`) and runs the API
  (`pnpm --filter @amdb/api start`), which serves the SPA from `WEB_DIST_DIR=../web/dist`. Its
  health check is `/api/health`.
- Migrations run at boot (`openDb` in `platform/db/open.ts` applies pending Drizzle migrations
  before the server listens), so there is no pre-deploy step. A failed migration fails the
  health check and the old deploy keeps serving.
- The Cloudflare record for `amdb.ty-pe.com` is **DNS-only (gray cloud)**. A proxied record adds
  Cloudflare as a second hop in `X-Forwarded-For`, and the rate limiter, which takes the client
  as the `TRUSTED_PROXY_HOPS=1`-th entry from the right, would then see a Cloudflare address.
  Every visitor would share a few anonymous buckets.
- No bucket. Images arrive in plan 3.

## Alternatives considered

- **`dev` and `production`, as in rmd ADR 0008.** It doubles the Railway cost, and there is no
  one to protect from a bad deploy yet. Add a `dev` environment when moderators work on real
  data.
- **Proxied Cloudflare record with `TRUSTED_PROXY_HOPS=2`.** It works, but ties rate limiting to
  Cloudflare's header behavior, and the DNS-only record is simpler to reason about.
- **Legacy `railway.json`.** Deprecated, and it covers one service rather than the project.
- **Dashboard-only configuration.** It can't be reviewed or diffed.

## Consequences

Every push to `main` reaches production once CI passes, so `main` must stay releasable until a
`dev` environment exists. Railway's config can't register custom domains, so the domain is
registered with `railway domain` on the linked `app` service, which needs the service to exist.
Both `plan` and `apply` refuse a config that lists it, so the runbook (docs/deploy.md step 3)
applies once without the domain, registers it, restores it and applies again. Secrets are set by hand and are not in
git. Turning on the Cloudflare proxy later requires `TRUSTED_PROXY_HOPS=2` in the same change.
Revisit this when moderators start working real data.

The first deploy (2026-11-05) passed the smoke test: health, TLS, email-code, Google and GitHub
sign-in, an anonymous submission approved by an admin, and the pending-edits notice. The record
was confirmed DNS-only (`dig` returns Railway's CNAME target), but separate anonymous rate-limit
buckets for two networks were not tested.
