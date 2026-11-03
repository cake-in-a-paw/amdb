# 0002. Stack and tooling

- **Status:** proposed
- **Date:** 2026-11-03

## Context

AMDB needs a database-backed API, a web app and tooling. The owner already runs another project,
rmd, on a stack that fits: the same choices let patterns, dependency versions and tooling carry
over.

## Decision

Same stack as rmd, for the owner's familiarity and shared patterns:

- **Language and repo:** TypeScript everywhere, a pnpm monorepo, and REST APIs.
- **API:** Hono with `@hono/zod-openapi`, so zod schemas give validation, the OpenAPI document,
  and generated client types.
- **Database:** Postgres through Drizzle (schema in TS, generated migrations), with PGlite for
  tests and local dev.
- **Auth:** Better Auth in the API.
- **Web:** a React + Vite single-page app, with TanStack Router and Query, and Tailwind.
- **Hosting:** Railway.
- **Tooling:** Vitest for tests; Prettier and oxlint for format and lint; husky with
  lint-staged and commitlint for hooks (no Python toolchain in this repo); GitHub Actions for CI.

## Alternatives considered

- Fastify, NestJS and Express (server);
- Kysely, Prisma and raw SQL (database layer);
- Next.js and SvelteKit (web);
- Supabase and GCP (hosting);
- the Python `pre-commit` framework (hooks), rejected because the repo has no Python toolchain.

All were rejected for the same reason: they'd give up the shared patterns with rmd for no gain
AMDB needs.

## Consequences

One language across the stack, types flow from the database to the client, and fixes and
patterns move between AMDB and rmd. A change to any of these gets a superseding ADR.
