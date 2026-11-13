# Postgres in Docker for tests and local dev: design

Status: approved by the owner in chat, 2026-11-13. Follows rmd's switch (rmd ADR 0013 and
`~/dev/rmd/docs/specs/2026-11-10-postgres-in-docker-design.md`), adapted to AMDB.

## Why

The owner never wanted PGlite and prefers Postgres in Docker.

It is also why CI is slow. `pnpm check` takes about 10 minutes on CI (run 43442759040), and 9.5 of
them are tests: the API suite takes 313 s and the web suite 286 s, one after the other, on the
2-core runner. Locally they take 77 s and 70 s.

Every test calls `setupTest()`, which opens a fresh in-memory PGlite and replays all 13
migrations. That happens about 178 times in the API suite and about 230 times in the web suite,
which uses the same helper through `@amdb/api/testing`. PGlite also runs every query on one
WebAssembly thread, and it isn't production's engine. It sorts text in plain character order,
while production sorts by English rules.

rmd made the same switch: its API tests went from 1,088 s to 111 s on CI, and `pnpm check` from
18 min 40 s to 2 min 13 s.

## Goals

- CI finishes in a few minutes.
- Local `pnpm test` and `pnpm check` are no slower than today, and ideally much faster.
- Tests, local dev and production run the same Postgres version with the same sort rules.
- Every test still gets its own database, so tests stay isolated and order-independent.

## Non-goals

- Deleting, merging or rewriting tests, beyond what the switch forces (see Sort order).
- Sharing a database across the tests in a file.
- Larger paid GitHub runners.
- Any change to how Railway hosts Postgres.

## Anti-goals

- Tests that pass or fail depending on which other tests ran first.
- Weakening or skipping an assertion to get through the switch (constitution VI). An expectation
  changes only with its reason in the commit.
- PGlite kept as a fallback anywhere, or its branch left in `openDb()` (XIII).
- A `pnpm test` that hangs, or prints a confusing error, when Docker isn't running. It fails at
  once and says to start Docker.
- A test run that can reach the dev database or a remote one.

## Decided

- **PGlite is removed completely:** from tests, local dev and every script. That means the
  `@electric-sql/pglite` dependency, the `pglite:` branch of `openDb()`, the comments and types
  that exist for two drivers (`platform/db/types.ts`, `catalog/repository.ts`), and the
  `pglite:.pglite` default in `.env.example`. No local `.pglite/` data exists, so nothing is
  carried over.
- **Production parity.** Production reports Postgres 18.6 (Debian 18.6-1.pgdg13), collation and
  ctype `en_US.utf8`, with the libc provider. It was read on 2026-11-13. Tests and local dev pin
  the official `postgres:18.6` image, which matches. The test setup refuses a server that isn't
  Postgres 18 with libc `en_US.utf8`, checked on `template1`.
- **A `compose.yaml` at the repo root**, compose project name `amdb`, so every checkout and
  worktree shares the same containers:
  - `postgres-test`, port **55442**: data on a tmpfs (2 GB), with `fsync`, `synchronous_commit`
    and `full_page_writes` off and `max_connections=300`, plus a TCP `pg_isready` healthcheck.
    Tests only.
  - `postgres-dev`, port **55443**: normal durability, data in the named volume `amdb-dev-data`,
    database `amdb`. Local dev's `DATABASE_URL` points at it, and a `pnpm db:up` script starts it.
  - Both ports are AMDB's own: rmd uses 55432 and 55433 under project name `rmd`.
- **One template database per test run.** A Vitest `globalSetup` builds `amdb_tpl_<runId>` from
  the real migrations, provides the server URL and run id to the tests, and at teardown drops the
  template and any leftover copies. Each `setupTest()` creates its own database as
  `CREATE DATABASE … TEMPLATE amdb_tpl_<runId>` and drops it when the test closes. The API and web
  suites both use this global setup, each with its own run id, so they can run at the same time.
- **The setup starts the container itself.** When `TEST_DATABASE_URL` is unset, it runs
  `docker compose up -d --no-recreate --wait postgres-test`. It checks `docker version` first, so
  a stopped Docker gives "start Docker" rather than a compose error.
- **Tests read only `TEST_DATABASE_URL`,** which must name a server, not a database. They never
  read `DATABASE_URL` or `.env`, so the setup's `CREATE` and `DROP DATABASE` can't touch dev or
  production. CI leaves it unset and starts the same compose service on the runner.
- **The API and web suites run in parallel** (`pnpm -r --parallel test`, or the equivalent),
  since the web tests import the API's source and don't need its tests to finish first.
- **Constitution VI's first bullet** changes from "against PGlite with the real migrations" to
  "against Postgres in Docker, production's major version and locale, with the real migrations;
  each test gets its own database". That's a MINOR bump, 0.3.0 → 0.4.0, as in rmd: the principle
  stands and only its engine narrows. ADR 0009 records it. It marks the PGlite parts of ADRs 0002
  and 0004 superseded, and records the CI time before and after.

## Sort order (my call, following rmd's owner call)

Tests switch from PGlite's character order to production's English order, and no query changes.
Any expectation that breaks only because of order is updated in its own commit, saying the tests
now sort like production. Any other failure is a real bug and is fixed in the code.

## Landing

- The work is built on a branch from `main`, where the constitution is at 0.3.0 and the next free
  ADR is 0009, and merged into `main` locally (the PR rule is relaxed).
- Pushing is not part of the build. It waits for the owner's yes and a check that no Wikidata
  import is running on Railway (`docs/import.md`), because a push redeploys and a redeploy kills
  a run. The CI time "after" in ADR 0009 is filled in from the first CI run after that push, in
  a follow-up docs commit.

## Calls I made for the builder

- **Local scripts** that read `DATABASE_URL` (`server.ts`, `import-wikidata.ts`) point at
  `postgres-dev`, through `.env.example`. `openDb()` takes only a Postgres URL.
- **`dump-openapi.ts` and `openapi.test.ts` need no server.** They build the app on a
  node-postgres pool that never connects, since building routes runs no query and `pg.Pool`
  connects only on first use. That keeps the real driver with no stub and no cast, and the OpenAPI
  dump works without Docker.
- **Per-test pools are small** (`max` of a few connections), so the API and web suites running at
  once stay well under `max_connections=300`. The builder sets the number from a measured run.
- **`auth-app.ts`, `art.test.ts` and the other tests** that open a database use the same per-test
  helper as `setupTest()`.

## Left to the builder

- Where the global setup and per-test database helper live, so the API and web configs can share
  them. The web suite already imports `@amdb/api/testing`.
- Tests that open their own database, `schema.test.ts` and `openapi.test.ts`, and any migration
  test that needs an empty database rather than a template copy.
- `scripts/dump-openapi.ts` opens a database only to build the app. Ideally it stops needing one;
  otherwise it uses the test container.
- `moderation.test.tsx` reaches the PGlite client through `$client`, and the web `setup.ts` has a
  comment about PGlite's boot time. Both change to match the real driver.
- The Vitest timeouts stay as they are, unless the switch shows they can come down.
- Pinning the GitHub Actions setup if CI needs a step to make Docker Compose available. The
  `ubuntu-latest` runner ships it.

## Done when

- `pnpm check` passes locally and on CI, and no code, config or current doc mentions PGlite.
  Old specs and plans may.
- With Docker stopped, `pnpm test` fails at once with a message saying to start Docker.
- The README's local setup works from a clean clone: `pnpm db:up`, `pnpm dev`.
- CI time on `main` before and after is in ADR 0009.
- Constitution VI, ADR 0009 and the superseded notes in ADRs 0002 and 0004 describe the new
  setup.
- Nothing is pushed while a production import is running.
