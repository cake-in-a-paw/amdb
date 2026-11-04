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
  - `test/harness.tsx`: renders the app on the real API, in process on PGlite.
- `packages/shared`: zod value lists shared by the API and the web app, and the typed API client.

## Run the API locally

Requires Node 22+ and pnpm 10 (`corepack enable`).

```bash
pnpm install
cp .env.example apps/api/.env
pnpm --filter @amdb/api dev      # http://localhost:3000/api/health
```

`DATABASE_URL=pglite:.pglite` keeps an embedded Postgres in `apps/api/.pglite/`, so no database
install is needed. Point it at a real Postgres URL to use one instead. Migrations run on startup.

## Run the web app locally

With the API running on port 3000:

```bash
pnpm --filter @amdb/web dev      # http://localhost:5173, proxies /api to the API
```

Port 5173 is fixed (`strictPort`): it must match `WEB_ORIGIN`, the origin Better Auth trusts.

Web tests run the real API in process on PGlite (`apps/web/test/harness.tsx`); only Better Auth's
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

API tests run against an in-memory PGlite database with the real migrations.

## Database changes

Edit `apps/api/src/platform/db/schema.ts`, then `pnpm --filter @amdb/api db:generate --name <change>`.
SQL Drizzle can't generate goes in `pnpm --filter @amdb/api db:custom --name <change>`.
