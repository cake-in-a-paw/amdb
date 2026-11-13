# AMDB

An open, CC0, crowd-sourced database of all media. The design spec is in
`docs/superpowers/specs/`; the rules for writing code are in `CLAUDE.md`; technical decisions are
recorded in `docs/decisions/`.

## Layout

- `apps/api`: REST API (Hono, Drizzle). OpenAPI document at `/api/openapi.json`.
  - `src/features/<feature>/`: one folder per feature, each with `routes.ts` (HTTP),
    `service.ts` (rules), `repository.ts` (Drizzle) and `schemas.ts`.
  - `src/platform/`: `db` and `http`, shared infrastructure that knows nothing about features.
  - `src/app.ts` wires everything; `src/server.ts` starts it.
- `apps/web`: the web app (React, Vite, TanStack Router and Query, Tailwind, shadcn/ui).
  - `src/routes/`: file-based routes; `src/routeTree.gen.ts` is generated and committed.
  - `test/harness.tsx`: renders the app on the real API, in process, on a per-test Postgres database.
- `packages/shared`: zod value lists shared by the API and the web app, and the typed API client.

## Run the API locally

Requires Node 24, pnpm 10 (`corepack enable`) and Docker.

```bash
pnpm install
cp .env.example apps/api/.env
pnpm db:up                       # starts Postgres in Docker
pnpm --filter @amdb/api dev      # http://localhost:3000/api/health
```

`pnpm db:up` starts the `postgres-dev` service from `compose.yaml` (port 55443, data in the Docker
volume `amdb-dev-data`), which `.env.example` points `DATABASE_URL` at. Migrations run on startup.

## Run the web app locally

With the API running on port 3000:

```bash
pnpm --filter @amdb/web dev      # http://localhost:5173, proxies /api to the API
```

Port 5173 is fixed (`strictPort`): it must match `WEB_ORIGIN`, the origin Better Auth trusts.

Web tests run the real API in process on Postgres in Docker (`apps/web/test/harness.tsx`); only Better Auth's
browser client is stubbed. ADR 0004 explains why.

## Checks

`pnpm install` also installs git hooks (husky):

- pre-commit formats and lints staged files and typechecks;
- commit-msg enforces Conventional Commits;
- pre-push runs `pnpm check`, then any global pre-push hook you have.

Notes:

- `HUSKY=0` also skips the chained global pre-push hook (the unsigned-commit guard).
- The pre-commit typecheck runs on the working tree, not just the staged files.

```bash
pnpm check       # format check, lint, typecheck, tests — the gate CI runs
pnpm test        # tests only
pnpm fmt         # auto-format
```

`apps/api/test/openapi.test.ts` compares the generated OpenAPI document with a committed
snapshot. After an intentional API change, refresh it and review the diff:

```bash
pnpm --filter @amdb/api -s openapi:dump > apps/api/test/fixtures/openapi.snapshot.json
```

The web app's typed client lives in `packages/shared/src/api`. After an API change, refresh the
snapshot, then regenerate `schema.ts` and commit both together (a drift test fails otherwise):

```bash
pnpm --filter @amdb/shared gen:api
```

API and web tests run against Postgres 18 in Docker (the `postgres-test` service, started
automatically), each test in its own copy of a migrated template. Set `TEST_DATABASE_URL` to use
another server.

## Deploy

Production runs on Railway at `https://amdb.ty-pe.com`, defined in `.railway/railway.ts` (ADR 0005).
`docs/deploy.md` is the first-time runbook. After that, a push to `main` deploys once CI passes.

## Database changes

Edit `apps/api/src/platform/db/schema.ts`, then `pnpm --filter @amdb/api db:generate --name <change>`.
SQL Drizzle can't generate goes in `pnpm --filter @amdb/api db:custom --name <change>`.
