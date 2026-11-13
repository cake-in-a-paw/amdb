# 0009. Postgres in Docker for tests and local dev

- **Status:** accepted
- **Date:** 2026-11-13

## Context

API tests, web tests and local dev ran on PGlite, Postgres compiled to WebAssembly (ADRs 0002 and
0004). The owner never wanted it. It also made `pnpm check` slow:

- **CI:** `pnpm check` took about 10 min 20 s (run 43442759040). The API tests took 313 s and the
  web tests 286 s, one after the other, on the 2-core runner.
- **Locally:** the API tests took 77 s and the web tests 70 s.
- **Cause:** every test opens a fresh in-memory PGlite and replays all 13 migrations. That is
  about 400 databases per run, and PGlite runs every query on one WebAssembly thread.

PGlite also isn't production's engine. It sorts text in plain character order, while production
(Postgres 18.6 on Debian, collation `en_US.utf8`) sorts by English rules. Principle VI asks for
tests on real Postgres.

rmd made the same switch (rmd ADR 0013): its API tests went from 1,088 s to 111 s on CI.

## Decision

- **Two Postgres 18.6 services in `compose.yaml`**, under the project name `amdb` so every
  checkout and worktree shares the same containers:
  - `postgres-test` on port 55442: data on a 2 GB tmpfs, with `fsync`, `synchronous_commit` and
    `full_page_writes` off, and `max_connections=300`. Tests only.
  - `postgres-dev` on port 55443: normal durability, data in the named volume `amdb-dev-data`,
    database `amdb`. `pnpm db:up` starts it, and `.env.example` points `DATABASE_URL` at it.
  - The ports are AMDB's own; rmd uses 55432 and 55433.
- **A template database per run.** `apps/api/test/global-setup.ts` builds `amdb_tpl_<runId>` from
  the real migrations and drops it, and any leftover copies, at the end. Each test creates its own
  database as a copy of the template (`openTestDb()` in `apps/api/test/helpers/test-db.ts`) and
  drops it when the test closes. The API and web suites share this setup, each with its own run
  id.
- **The setup starts the container.** When `TEST_DATABASE_URL` is unset, it runs
  `docker compose up -d --no-recreate --wait postgres-test`, after checking that Docker is
  running so a stopped Docker says "start Docker".
- **`TEST_DATABASE_URL`** points the tests at another server. It must name a server, not a
  database. Tests read only this variable, never `DATABASE_URL` or `.env`, so the setup's
  `CREATE DATABASE` and `DROP DATABASE` can't reach dev or production. CI leaves it unset and
  starts the same compose service on the runner.
- **The locale must match production.** The setup refuses a server that isn't Postgres 18 with
  the libc provider and `en_US.utf8`.
- **The API and web suites run in parallel** (`pnpm -r --parallel test`), since the web tests
  import the API's source and don't need its tests to finish first.
- **The OpenAPI dump and its test need no database.** They build the app on a node-postgres pool
  that never connects.
- **PGlite is removed** from the API, the tests, local dev and every script, including the
  `@electric-sql/pglite` dependency and the `pglite:` branch of `openDb()`.
- **One new dependency:** `drizzle-orm` 0.45.4 as an `apps/web` devDependency, the same pin as the
  API. `apps/web/test/moderation.test.tsx` uses its `sql` tag to build a query that backdates a
  row, now that the PGlite client is gone.
- **The constitution moves from 0.3.0 to 0.4.0.** Principle VI's first bullet now names Postgres
  in Docker with production's major version and locale. That is a MINOR bump: the principle
  stands and only its engine narrows.

## Alternatives considered

- **A PGlite snapshot (`loadDataDir`)** — faster setup, but queries stay single-threaded and it
  still isn't production's engine.
- **One shared database, truncated between tests** — tests could come to depend on each other's
  leftovers.
- **Larger paid CI runners** — costs money on every run and leaves local runs slow.
- **A GitHub Actions service container** — its `options` can't pass the `-c` server flags, so CI
  uses the same compose file as local runs.

## Consequences

- Docker is required to run the tests and local dev. With Docker stopped, `pnpm test` fails at
  once and says to start it.
- Old local PGlite data isn't migrated. Local dev starts from an empty `postgres-dev`.
- Local times, before (PGlite, suites one after the other): API 77 s, web 70 s.
- Local times, after, each suite alone: API 15.5 s (37 files, 507 tests), web 23.2 s (27 files,
  409 tests).
- A cold `pnpm check` with the suites in parallel takes 1 min 03 s. The API suite takes 46.0 s and
  the web suite 49.8 s in that run, each slower than alone because they share the machine's cores
  and the one Postgres server.
- Real Postgres exposed one race that PGlite's slower API had hidden: `artwork.test.tsx` now waits
  for the art query to settle as "unavailable" before it leaves the page. No expected sort orders
  changed.
- CI time on `main`: recorded after the first run.
- An interrupted test run leaves its databases on the tmpfs until
  `docker compose -p amdb down postgres-test` clears them.
- The setup starts `postgres-test` with `--no-recreate`, so one worktree's differing
  `compose.yaml` can't recreate the shared container (and wipe its tmpfs) under another's run. The
  cost: after changing the test service, run
  `docker compose -p amdb up -d --force-recreate postgres-test` by hand. A stale container is
  still caught by the version and locale check.
- Revisit if the 2 GB tmpfs or 300 connections stop being enough, or if production leaves
  Postgres 18 or glibc.
