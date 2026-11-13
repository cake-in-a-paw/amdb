# Postgres in Docker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace PGlite with Postgres 18.6 in Docker for the API and web tests and for local dev.
Every test gets its own copy of a migrated template database, and the two suites run in parallel.

**Architecture:**
- A root `compose.yaml` (project `amdb`) defines `postgres-test`, in memory with no durability,
  and `postgres-dev`, on a named volume.
- A Vitest `globalSetup` in `apps/api/test/` starts or reuses `postgres-test`, checks its version
  and locale, builds a template database for the run, and provides the server URL and run id.
  The web suite's config points at the same file.
- `setupTest()` and `setupAuthTest()` copy the template per test and drop the copy on close.
- PGlite is deleted from the code, the dependencies and the docs.

**Tech Stack:** `postgres:18.6` (official image), Docker Compose v2, node-postgres (`pg` 8.23.1,
already a dependency), the Drizzle node-postgres migrator, and Vitest 5 `globalSetup` with
`provide`/`inject`.

**Spec:** `docs/superpowers/specs/2026-11-13-postgres-in-docker-design.md`

**Reference implementation:** rmd made the same change. Read these and adapt them, renaming `rmd`
to `amdb`:
- `/Users/tylerpeckenpaugh/dev/rmd/compose.yaml`
- `/Users/tylerpeckenpaugh/dev/rmd/apps/api/test/global-setup.ts`
- `/Users/tylerpeckenpaugh/dev/rmd/apps/api/test/helpers/test-db.ts`

## Global Constraints

- **Image:** `postgres:18.6`, pinned, in both services. Data mounts at `/var/lib/postgresql`, not
  `…/data`.
- **Compose project name:** `amdb`.
  - `postgres-test`: host port `55442`, user and password `postgres`.
  - `postgres-dev`: host port `55443`, database `amdb`, volume `amdb-dev-data`.
- **Locale:** the setup refuses any server that isn't Postgres 18 with the libc provider (`c`)
  and `en_US.utf8`, checked on `template1`. Production reports 18.6, libc, `en_US.utf8`.
- **Tests read only `TEST_DATABASE_URL`,** which names a server, not a database. They never read
  `DATABASE_URL` or `.env`.
- **The template is rebuilt every run,** with names that carry the run id:
  - template `amdb_tpl_<runId>`;
  - copies `amdb_t_<runId>_<random>`.
- **Per-test pool:** `pg.Pool` with `max: 4`.
- **No PGlite anywhere** in code, config, dependencies or current docs when done. Old specs and
  plans may mention it. The `pglite:` branch of `openDb()` is deleted, not kept.
- **No loosened assertions** (constitution VI). An expectation changes only because Postgres now
  sorts like production, and the commit body says so.
- **Docker stopped:** `pnpm test` fails within seconds with `Start Docker to run the tests`.
- **Commits:**
  - Conventional Commits, scopes `api|web|shared|db|adr|ci`, `docs:` for docs, lowercase subject
    of 100 characters or fewer, body lines of 100 characters or fewer.
  - American spelling.
  - Signed with
    `git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$HOME/.ssh/id_claude_signing.pub" commit -S`.
  - Trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
    `Claude-Session: https://claude.ai/code/session_01LmZcdVVqP7uCx7Erhjuswb`.
  - Never `git add -A`, never a bare `git stash`.
- **Verification:** `pnpm test` passes before every commit, and `pnpm check` at the end of each task.
- **Never push.** Task 4 belongs to the controller and the owner.

## Review Focus

1. **The API and web suites start at the same moment.** With the suites in parallel, both global
   setups run `docker compose up` together on a cold machine. Expected: both succeed. One of them
   may lose the race to create the container, so a failed `up` is retried, up to 3 times, 2 s
   apart, before its error is thrown (Task 1, Step 4; checked in Task 2, Step 6).
2. **Two runs at once** (two worktrees or sessions). Neither drops the other's template or copies:
   names carry the run id, and teardown drops only its own (Task 1 test).
3. **A container left from older migrations.** The template is rebuilt, and its migration count
   equals the journal's entry count (Task 1 test).
4. **A developer's `DATABASE_URL` pointing at the dev database.** Tests ignore it (Task 1, Step 5).
5. **A test that leaves a connection open.** Dropping the copy still works
   (`DROP DATABASE … WITH (FORCE)`), and a full parallel run stays under `max_connections`
   (Task 1 test, Task 2, Step 6).

---

### Task 1: Tests on per-test Postgres databases

**Files:**
- Create: `compose.yaml` (repo root; `postgres-test` only in this task)
- Create: `apps/api/test/global-setup.ts`
- Create: `apps/api/test/helpers/test-db.ts`
- Create: `apps/api/test/test-db.test.ts`
- Modify: `apps/api/vitest.config.ts` and `apps/web/vitest.config.ts` (add `globalSetup`)
- Modify: `apps/api/test/helpers/setup.ts:17`, `apps/api/test/helpers/auth-app.ts:28`,
  `apps/api/test/schema.test.ts:9` (the `openDb('pglite:memory')` calls)
- Modify: any test whose expectation changes only because of sort order (Step 7)

**Interfaces:**
- Consumes: `MIGRATIONS_FOLDER` and `OpenedDb` from `apps/api/src/platform/db/open.ts`, and
  `schema` from `src/platform/db/schema.ts`.
- Produces:
  - `openTestDb(): Promise<OpenedDb>` in `apps/api/test/helpers/test-db.ts`: a fresh copy of the
    run's template, dropped on `close()`.
  - The Vitest provided keys `testDatabaseUrl: string` (the server URL, no database) and
    `testRunId: string`. Their `declare module 'vitest' { interface ProvidedContext … }` block
    lives in `test-db.ts`, not the global setup, so the web typecheck sees it through
    `@amdb/api/testing`.
  - The compose service `postgres-test`.

- [ ] **Step 1: Write `compose.yaml` with `postgres-test`**

  Use rmd's service with the Global Constraints' name and port. That means a 2 GB tmpfs at
  `/var/lib/postgresql`, the `-c fsync=off -c synchronous_commit=off -c full_page_writes=off -c
  max_connections=300` flags, and the TCP `pg_isready` healthcheck.

- [ ] **Step 2: Write the failing tests in `apps/api/test/test-db.test.ts`**

  These tests follow rmd's first four, minus the empty-database test, since AMDB has no migration
  tests that need one:
  - `gives each test its own database`: a row inserted through one copy isn't visible in another.
  - `drops the database on close, even with a connection left open`:
    - `current_database()` contains `inject('testRunId')`;
    - a straggler `pg.Client` stays connected;
    - after `close()`, `pg_database` has no row with that name.
  - `starts from a template with every migration applied`:
    `select count(*)::int as n from drizzle.__drizzle_migrations` equals the number of entries in
    `apps/api/drizzle/meta/_journal.json`, which is 13 today. Read the file, don't hard-code the
    count.
  - `runs Postgres 18 and sorts text like production`:
    - `server_version_num / 10000` is `18`;
    - `select t from (values ('Zebra'), ('apple'), ('Apple')) v(t) order by t` returns
      `['apple', 'Apple', 'Zebra']`. Character order (C) would give `['Apple', 'Zebra', 'apple']`.

- [ ] **Step 3: Run them and confirm they fail**

  Run: `pnpm --filter @amdb/api exec vitest run test/test-db.test.ts`
  Expected: FAIL, because `helpers/test-db` doesn't exist.

- [ ] **Step 4: Implement the global setup and `openTestDb()`**

  Adapt rmd's two files with these differences:
  - Compose URL `postgres://postgres:postgres@localhost:55442`; the compose file is the repo root's.
  - The message is `Start Docker to run the tests (the docker command is missing or can't reach the
    Docker daemon).`, since both suites use the setup.
  - **Retry `docker compose up -d --no-recreate --wait --wait-timeout 180 postgres-test`** up to 3
    times, 2 s apart, after the Docker check passes (Review Focus 1). Throw the last error.
  - Template `amdb_tpl_<runId>`, copies `amdb_t_<runId>_<random>`.
  - The per-test `pg.Pool` gets `max: 4`.
  - Keep `withPrintableErrors`, the version and locale check on `template1`, the template rebuild,
    the `55006` retry, and the teardown with `starts_with`.
  - Both `vitest.config.ts` files get `globalSetup`. The API's is `['test/global-setup.ts']`, the
    web's is `['../api/test/global-setup.ts']`. Keep `testTimeout: 20_000`.

- [ ] **Step 5: Run the new tests**

  Run: `pnpm --filter @amdb/api exec vitest run test/test-db.test.ts`. Expected: PASS.
  Run: `DATABASE_URL=postgres://nobody@127.0.0.1:1/nope pnpm --filter @amdb/api exec vitest run test/test-db.test.ts`
  Expected: PASS, because tests ignore `DATABASE_URL`.
  Run: `DOCKER_HOST=unix:///nonexistent.sock pnpm --filter @amdb/api exec vitest run test/test-db.test.ts`
  Expected: fails within about 10 s, and the output contains `Start Docker to run the tests`.

- [ ] **Step 6: Switch the test databases**

  `setupTest()`, `setupAuthTest()` and the `schema.test.ts` `beforeEach` call `openTestDb()`
  instead of `openDb('pglite:memory')`.

- [ ] **Step 7: Run both suites and triage every failure**

  Run: `pnpm --filter @amdb/api test`, then `pnpm --filter @amdb/web test`.
  Each failure falls into one of three cases:
  - **Only the order of text differs**, because Postgres now sorts with `en_US.utf8` as in
    production: change the expected order, leave the values alone, and write the reason in a
    comment next to it.
  - **Anything else** is a real difference between PGlite and Postgres: fix the code.
  - **Not sure which:** stop and report it as `DONE_WITH_CONCERNS` with the failing test's name and
    output. Never loosen an assertion.

  Run both suites again. Expected: all pass.

- [ ] **Step 8: Commit**

  One commit, since splitting the switch from the expectations it changes would leave a commit
  with failing tests. `openapi.test.ts` still uses `openDb('pglite:memory')` here; Task 2
  replaces it.

```bash
git add compose.yaml apps/api/vitest.config.ts apps/web/vitest.config.ts apps/api/test/global-setup.ts \
  apps/api/test/helpers/test-db.ts apps/api/test/test-db.test.ts apps/api/test/helpers/setup.ts \
  apps/api/test/helpers/auth-app.ts apps/api/test/schema.test.ts   # plus any test changed in Step 7
git commit -S -m "test(api): run the api and web tests on postgres in docker"
```

  The body says each test gets its own copy of the run's migrated template, and names every
  expectation Step 7 changed with its reason: PGlite sorted in character order (C), while
  production sorts with `en_US.utf8`.

### Task 2: Local dev on Postgres, PGlite removed, suites in parallel

**Files:**
- Modify: `compose.yaml` (add `postgres-dev`)
- Modify: `apps/api/src/platform/db/open.ts`, `apps/api/src/platform/db/types.ts`
- Modify: `apps/api/scripts/dump-openapi.ts`, `apps/api/test/openapi.test.ts`
- Modify: `apps/api/test/helpers/auth-app.ts:10` (the env value)
- Modify: comments in `apps/api/src/features/catalog/repository.ts:138,171`,
  `apps/api/test/art.test.ts:506`, `apps/web/test/harness.tsx:90` and `apps/web/test/setup.ts:11`
- Modify: `apps/web/test/moderation.test.tsx:21-30` (`backdate`)
- Modify: `apps/api/package.json` (remove `@electric-sql/pglite`), `pnpm-lock.yaml`
- Modify: root `package.json` (`db:up`, parallel `test`)
- Modify: `.env.example:1-2`, `.gitignore:3`

**Interfaces:**
- Consumes: Task 1's `compose.yaml` and `openTestDb()`.
- Produces:
  - `openDb(url: string): Promise<OpenedDb>`, which now takes only a Postgres URL.
  - `Db` = `NodePgDatabase<typeof schema>` in `types.ts`. `Tx` and `DbOrTx` are still derived from
    it.
  - The service `postgres-dev`, and the root script `db:up`.

- [ ] **Step 1: Add `postgres-dev`** as rmd's, with the Global Constraints' port, database and volume.

- [ ] **Step 2: Remove PGlite from `openDb()` and `Db`**

  - Delete the `pglite:` branch, the four PGlite and pglite-drizzle imports, and the cast.
  - The doc comment becomes "A Postgres connection string. Pending migrations run before this
    returns."
  - `types.ts`: the `Db` type and its comment become "The node-postgres driver's database, used
    everywhere."

- [ ] **Step 3: Build the OpenAPI document without a database**

  `dump-openapi.ts` and `openapi.test.ts` build the app on `drizzle({ client: new pg.Pool(), schema })`
  and never call `openDb`. A comment says the pool never connects: node-postgres connects on first
  query, and serving `/api/openapi.json` runs none. End the pool afterwards.
  Run: `pnpm --silent --filter @amdb/api openapi:dump | diff - apps/api/test/fixtures/openapi.snapshot.json`
  Expected: no output, even with Docker stopped.

- [ ] **Step 4: Remove the remaining PGlite traces**

  - `auth-app.ts`'s env object gets `DATABASE_URL: 'postgres://localhost/unused'`, which only needs
    to pass env parsing.
  - `backdate` in `moderation.test.tsx` uses `api.db.execute(sql…)` with `sql.identifier` for the
    table and column, with no cast and no `$client`.
  - The comments listed under Files lose their two-driver and PGlite wording. `web/test/setup.ts`
    says each test copies a migrated template before its first render.
  - `.env.example`: `# Postgres URL. Locally, \`pnpm db:up\` starts one in Docker (compose.yaml).`
    then `DATABASE_URL=postgres://postgres:postgres@localhost:55443/amdb`.
  - `.gitignore`: delete the `.pglite/` line. No local PGlite data exists.
  - Run: `pnpm --filter @amdb/api remove @electric-sql/pglite`.
  - Run: `rg -n -i pglite --glob '!node_modules' --glob '!docs/superpowers/**' --glob '!docs/decisions/**' --glob '!README.md' .`
    Expected: no output. The README and ADRs belong to Task 3.

- [ ] **Step 5: Root scripts**

  - `"db:up": "docker compose up -d --wait postgres-dev"`.
  - `"test": "pnpm -r --parallel test"`, so the API and web suites run at once.

- [ ] **Step 6: Run the checks, cold, and the server**

  Run: `docker compose -p amdb down postgres-test`, then `pnpm check`.
  Expected: passes. Both global setups start against a container that doesn't exist yet (Review
  Focus 1), and the run stays under 300 connections (Review Focus 5).
  Record the wall time of `pnpm test`, and each suite's `Duration`, in the report.
  Run: `pnpm db:up && DATABASE_URL=postgres://postgres:postgres@localhost:55443/amdb pnpm --filter @amdb/api start`
  Expected: the server starts after the migrations run. Stop it afterwards.

- [ ] **Step 7: Commit**

```bash
git commit -S -m "feat(api): run local dev on postgres in docker and remove pglite"
```

### Task 3: Record the decision

**Files:**
- Create: `docs/decisions/0009-postgres-in-docker-for-tests-and-local-dev.md` (template `0000`)
- Modify: `docs/decisions/0002-stack-and-tooling.md:19`, and `docs/decisions/0004-web-stack.md`
  lines 11, 74 and 180
- Modify: `CLAUDE.md` (Principle VI's first bullet, and the version line)
- Modify: `README.md` lines 16, 22-30, 42 and 78

**Interfaces:** consumes Tasks 1–2 as built, including Task 2's timings.

- [ ] **Step 1: Write ADR 0009** (status `accepted`, date 2026-11-13)

  - **Context:**
    - the owner never wanted PGlite;
    - CI `pnpm check` took about 10 min 20 s (run 43442759040): API tests 313 s and web tests
      286 s, one after the other;
    - about 400 fresh PGlite databases per run, each replaying 13 migrations;
    - character-order sorting, against production's `en_US.utf8`;
    - rmd's result (ADR 0013 there: 1,088 s → 111 s of API tests on CI).
  - **Decision:** the spec's Decided list. That covers the compose services and ports, the template
    per run, `TEST_DATABASE_URL`, the locale check, the suites in parallel, and PGlite removed.
  - **Alternatives considered:**
    - a PGlite snapshot via `loadDataDir`: faster setup, but still single-threaded and not
      production's engine;
    - one shared database truncated between tests: tests could depend on each other's leftovers;
    - larger paid runners;
    - a GitHub Actions service container: its `options` can't pass the `-c` server flags, so CI
      uses the same compose file.
  - **Consequences:**
    - Docker is required for tests and local dev;
    - the local times from Task 2, before and after;
    - "CI time on `main`: recorded after the first run";
    - `--no-recreate` means a changed test service needs
      `docker compose -p amdb up -d --force-recreate postgres-test` by hand;
    - revisit if the 2 GB tmpfs or 300 connections stop being enough, or if production leaves
      Postgres 18 or glibc.

- [ ] **Step 2: Mark the superseded parts**

  - ADR 0002's Database bullet ends "… PGlite for tests and local dev: superseded by
    [0009](0009-postgres-in-docker-for-tests-and-local-dev.md)."
  - ADR 0004 gets the same note on its three PGlite mentions, without rewriting them. Its status
    line adds "in part superseded by 0009 (the test database)".

- [ ] **Step 3: Amend the constitution**

  - Principle VI's first bullet: "Tests drive the HTTP API against Postgres in Docker, the same
    major version and locale as production, with the real migrations; each test gets its own
    database."
  - Version `0.3.0` → `0.4.0`, Last Amended `2026-11-13`.
  - This is MINOR: the principle stays, and only its engine narrows.

- [ ] **Step 4: Update the README**

  - Line 16: the harness renders "on the real API, in process, on a per-test Postgres database".
  - "Run the API locally": requires Docker. Add `pnpm db:up` before the dev command, and replace
    the PGlite paragraph with one on `postgres-dev` (port 55443, volume `amdb-dev-data`).
  - Line 42: web tests run the real API in process on Postgres in Docker.
  - Line 78: "API and web tests run against Postgres 18 in Docker (the `postgres-test` service,
    started automatically), each test in its own copy of a migrated template. Set
    `TEST_DATABASE_URL` to use another server."

- [ ] **Step 5: Check and commit**

  Run: `pnpm check`. Expected: passes.
  Run: `rg -n -i pglite README.md CLAUDE.md`. Expected: no output.

```bash
git commit -S -m "docs(adr): use postgres in docker for tests and local dev"
```

### Task 4: Land it (controller and owner only)

- [ ] **Step 1:** Merge the branch into `main` locally once the final review is clean.
- [ ] **Step 2:** With the owner's yes, and only once no Wikidata import is running on Railway
  (`docs/import.md`), push and watch CI. Record CI's `pnpm check` duration in ADR 0009's
  Consequences, and commit `docs(adr): record the ci time with postgres in docker`.
