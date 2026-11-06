# Wikidata Seed Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed AMDB's catalog from Wikidata (films, TV, anime, books) through the revision log, best-known works first, within a database-size cap.

**Architecture:** A new `imports` feature records import runs and exposes them read-only over HTTP. The changes service gains one write path, `importSubmission`, which stores a run-authored submission as `approved` and applies it through `apply.ts`. A Wikidata client (polite, injectable `fetch`) feeds a pure mapper, and a runner turns each mapped work into one submission. A CLI script drives the runner against `DATABASE_URL`.

**Tech Stack:** Hono + @hono/zod-openapi, Drizzle, PGlite in tests, Vitest, `tsx` scripts. No new dependencies: `fetch`, `AbortSignal.timeout` and JSON only.

**Spec:** `docs/superpowers/specs/2026-11-05-wikidata-importer-design.md` (the importer's spec), under `docs/superpowers/specs/2026-11-02-amdb-design.md` §4.3 and §6.2.

## Global Constraints

- Constitution (CLAUDE.md) applies, in particular:
  - II: only CC0 sources, with the evidence recorded.
  - III: no write bypasses the revision log, and every catalog write is in `features/changes/apply.ts`.
  - VI: tests run against PGlite; only Wikidata is faked, through an injected `fetch`.
  - VIII: feature folders with `routes.ts`, `service.ts`, `repository.ts`, `schemas.ts`.
  - IX: comment every cast.
  - X: committed migrations only; a 409, not a 500.
  - XI: one error shape.
- License evidence URL, recorded on every run: `https://www.wikidata.org/wiki/Wikidata:Licensing`.
- User-Agent, exactly: `AMDB-importer/0.1 (https://github.com/cake-in-a-paw/amdb)`. No email anywhere in the repo.
- Endpoints:
  - Query service: `https://query.wikidata.org/sparql`.
  - Entity API: `https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&maxlag=5`, with at most 50 ids per call.
- Request discipline:
  - Requests are serial, at least 500 ms apart.
  - Each request times out after 30 s.
  - 429 and 503 retry up to 5 tries, waiting `Retry-After` seconds, or else 5 s, 10 s, 20 s, 40 s.
- Size cap: `--max-db-bytes` defaults to `3_500_000_000`.
- Changes use the commit scopes `api`, `db`, `web` and `shared`. Commits are signed with the Claude key. American spelling.

## Review Focus

1. **Item with no English label, or a label over 500 characters:** skipped and counted as `skipped.no_title`. A run is never aborted for it.
2. **Two items sharing an IMDb, ISBN or Open Library id (a `duplicate_external_id` 409):** that work is retried once with only its `wikidata` id. If it still conflicts, it is skipped and counted. The rest of the batch commits.
3. **Dates:**
   - Precision coarser than a year, or a negative (BCE) year, gives no date.
   - Several P577 values: the earliest valid one is used.
   - A day that doesn't exist in its month drops the day.
4. **Entity API problems:**
   - A redirected or missing entity (`missing` key, or `redirects`) is mapped under the QID it redirects to, or skipped if missing.
   - A `maxlag` error body (HTTP 200 with `error.code === "maxlag"`) is retried like a 503.
5. **Re-running after a partial or failed run:** imports only works not yet present. It reuses existing creators, series, properties and tags (by `wikidata` id or slug) rather than creating duplicates.

---

### Task 1: Import runs and run-authored submissions

**Files:**
- Modify: `apps/api/src/platform/db/schema.ts`. Add the `importRuns` table, and `submissions.importRunId` with its check.
- Create: `apps/api/drizzle/0009_import_runs.sql` (via `pnpm --filter @amdb/api db:generate`, then hand-edit the check constraint if it isn't generated).
- Create: `apps/api/src/features/imports/{schemas,repository,service,routes}.ts`.
- Modify: `apps/api/src/app.ts` (wire `importsRoutes`).
- Modify: `apps/api/src/features/changes/service.ts`.
  - Add `importSubmission`.
  - `RELATION_RULES.external_id.from` accepts `work | creator | series | property`.
- Modify: `apps/api/src/features/changes/author.ts`, `schemas.ts`, `repository.ts` (history and queue selects), `routes.ts`. Add the importer author.
- Test: `apps/api/test/imports.test.ts`.

**Interfaces:**
- Produces, in the database:
  - `import_runs` columns:
    - `id uuid pk`
    - `source text not null`
    - `params jsonb not null`
    - `license_url text not null`
    - `status text not null`, one of `running`, `finished`, `failed`, `capped`
    - `stats jsonb not null default '{}'`
    - `error text`
    - `started_at`
    - `finished_at`
  - `submissions.import_run_id uuid references import_runs`.
  - Check `submissions_one_author`: exactly one of `author_user_id`, `anon_hash`, `import_run_id` is non-null.
- Produces, in the imports service (`createImportsService(db)`):
  - `startRun({ source: 'wikidata', params: Record<string, unknown>, licenseUrl: string }): Promise<{ id: string }>`
  - `finishRun(id: string, outcome: { status: 'finished' | 'failed' | 'capped'; stats: ImportStats; error?: string }): Promise<void>`
  - `getRun(id: string)`
- Produces, in the changes service:
  - `importSubmission(runId: string, changes: ChangeInput[]): Promise<{ id: string; changes: { id: string; entityId: string | null }[] }>`
  - It runs `plan()` with an importer actor, inserts the submission with owner `{ importRunId }`, and applies each change in order with status `approved` (`reviewedBy` null, `reviewedAt` now), all in one transaction.
  - It throws the same `ApiError`s as a submit, such as `duplicate_external_id` 409.
- Produces, over HTTP: `GET /api/import-runs/{id}` returns 200 `{ id, source, status, params, licenseUrl, stats, error, startedAt, finishedAt }`, or 404.
- Produces, in author schemas: `AuthorSchema` and `ReviewAuthorSchema` add the variant `{ importRun: { id: uuid, source: 'wikidata' } }`.

- [ ] **Step 1: Write the failing tests** in `apps/api/test/imports.test.ts`:
  - `an imported submission is live at once, attributed to its run in public history, and absent from the queue`:
    - Start a run.
    - `importSubmission` a work create plus an `external_id` relate (`wikidata`, `Q1`).
    - Expect `GET /api/entities/<id>` 200.
    - Expect the history item's `author` to equal `{ importRun: { id: runId, source: 'wikidata' } }` and its status to be approved.
    - Expect the moderator queue to have 0 items.
  - `a creator can carry a wikidata external id`: `importSubmission` a creator create plus `external_id` from that creator. Expect 200, and the creator's entity view shows the id.
  - `a duplicate external id across imported submissions is a 409, and nothing of that submission is written`.
  - `a moderator can revert an imported change`: revert through the existing revert route, and expect 200.
  - `GET /api/import-runs/{id} is public and 404s for an unknown id`: the body has `licenseUrl: 'https://www.wikidata.org/wiki/Wikidata:Licensing'`.
  - `a submission with no author, or with two authors, violates submissions_one_author`: raw insert through `db`, expect it to reject.
- [ ] **Step 2: Run** `cd apps/api && pnpm vitest run test/imports.test.ts`. Expect every test to fail.
- [ ] **Step 3: Implement.**
  - The migration and schema.
  - The imports feature folder, with its pass-through route.
  - `importSubmission`.
  - The importer author variant in `publicAuthor`/`reviewAuthor` (signature becomes `(userId, handle, run: { id: string; source: string } | null)`). The history and queue selects left-join `import_runs` for `source`.
- [ ] **Step 4: Regenerate.**
  1. `cd apps/api && pnpm -s openapi:dump > test/fixtures/openapi.snapshot.json`
  2. `cd packages/shared && pnpm -s gen:api`
  3. Run the API suite and expect all of it to pass.
- [ ] **Step 5: Commit** `feat(api): import runs and run-authored submissions`.

### Task 2: Show an import as the author in the web app

**Files:**
- Modify: `apps/web/src/lib/change-text.ts` (`authorName`).
- Modify: history list and queue item, wherever `authorName` renders. A run author links to `/api/import-runs/<id>`, the evidence.
- Test: `apps/web/test/change-text.test.ts`, `apps/web/test/history.test.tsx`.

**Interfaces:**
- Consumes: the author variant `{ importRun: { id, source } }` from Task 1.
- Produces: `authorName(author)` returns `'Wikidata import'` for that variant.

- [ ] **Step 1: Write the failing tests:**
  - `authorName({ importRun: { id: 'r', source: 'wikidata' } }) === 'Wikidata import'`.
  - A history test seeded through the API's `importSubmission` (expose it through the test API helper, or seed with the Task 1 service directly) shows the text "Wikidata import" as a link to `/api/import-runs/<runId>`.
- [ ] **Step 2: Run** `cd apps/web && pnpm vitest run test/change-text.test.ts test/history.test.tsx`. Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(web): show a Wikidata import as a change's author`.

### Task 3: Wikidata client

**Files:**
- Create: `apps/api/src/features/imports/wikidata/client.ts`.
- Test: `apps/api/test/wikidata-client.test.ts`.

**Interfaces:**
- Produces:
  - `createWikidataClient({ fetch, sleep = setTimeout-based, now = Date.now }): WikidataClient`
  - `WikidataClient.sparql(query: string): Promise<SparqlRow[]>`. It sends a GET with `format=json` and `Accept: application/sparql-results+json`. `SparqlRow` is `Record<string, string>`, the bindings' `.value`s.
  - `WikidataClient.entities(ids: string[]): Promise<Record<string, WikidataEntity>>`. It takes 50 ids or fewer, uses `props=labels|descriptions|claims|sitelinks`, `languages=en`, and resolves redirects (keyed by the requested id).
  - `WikidataUnavailable extends Error`, with `status` and `url`.

- [ ] **Step 1: Write the failing tests**, each driving a fake `fetch` and a recording `sleep`:
  - `sends the AMDB User-Agent and a 30 s timeout signal on every request`.
  - `waits Retry-After seconds on a 429, then succeeds`: `sleep` called with 7000 for `Retry-After: 7`.
  - `backs off 5, 10, 20, 40 s on 503s without Retry-After and gives up after 5 tries with WikidataUnavailable`.
  - `treats a maxlag error body as retryable`.
  - `spaces consecutive requests at least 500 ms apart`.
  - `a missing entity is absent from the result; a redirected one is returned under the requested id`.
  - `entities() refuses more than 50 ids`.
- [ ] **Step 2: Run** `pnpm vitest run test/wikidata-client.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** with the Global Constraints values verbatim.
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(api): a polite Wikidata client`.

### Task 4: Candidate discovery and ranking

**Files:**
- Create: `apps/api/src/features/imports/wikidata/discover.ts`.
- Test: `apps/api/test/wikidata-discover.test.ts`.

**Interfaces:**
- Consumes: `WikidataClient.sparql`.
- Produces:
  - `CLASSES`: the spec's table as `{ qid, mediaType, subtype }[]`, in the precedence order anime film, anime series, film, TV series, literary work.
  - `discover(client, { classes: string[], minSitelinks: number }): Promise<Candidate[]>`, where `Candidate = { qid: string; sitelinks: number; mediaType: MediaType; subtype: Subtype | null }`.
  - Each class runs one query: `?item wdt:P31 wd:<class>; wikibase:sitelinks ?sl; rdfs:label ?l. FILTER(LANG(?l)="en") FILTER(?sl >= <min>)`, returning `?item ?sl`.
  - Results are deduplicated by QID, keeping the highest-precedence class, then sorted by sitelinks descending, then by QID number ascending.

- [ ] **Step 1: Write the failing tests:**
  - `ranks by sitelinks, most first, ties by QID`.
  - `an item in both anime film and film is an anime_film`.
  - `the query names the class, the English-label filter and the sitelink floor`: assert on the query string the fake received.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(api): find and rank Wikidata candidates`.

### Task 5: Map an entity to a work record

**Files:**
- Create: `apps/api/src/features/imports/wikidata/map.ts`.
- Create: `apps/api/test/fixtures/wikidata/` (small hand-made `wbgetentities` JSON).
- Test: `apps/api/test/wikidata-map.test.ts`.

**Interfaces:**
- Produces:
  - `mapWork(entity: WikidataEntity, candidate: Candidate, today: Date): WorkRecord | { skip: 'no_title' }`.
  - `WorkRecord`:
    - `qid`
    - `fields` (valid `WorkFields` input)
    - `creators: { qid; role }[]`
    - `series: { qid; position }[]`
    - `franchises: string[]`
    - `genres: string[]`
    - `links: { qid; linkType: 'adapted_from' | 'sequel_of' }[]`
    - `externalIds: { scheme: IdScheme; value: string }[]`, with `wikidata` always first
  - `mapRef(entity): { name: string; kind: 'person' | 'organization'; description?: string } | null`, for creators, series, properties and genres. It returns null without an English label.
  - `genreTag(label: string): { name: string; slug: string }`.
  - All values come from the spec's mapping tables.

- [ ] **Step 1: Write the failing tests:**
  - A film fixture maps to the exact `fields`, roles and ids:
    - title from the English label;
    - originalTitle from a non-English P1476;
    - day-precision P577 becomes year, month and day;
    - P2047 in hours becomes minutes.
  - `release precision: month keeps year and month, decade drops the date, BCE drops the date, earliest of several wins, 31 Feb drops the day`.
  - `lifecycle: past → released, future → upcoming, none → unknown`.
  - `series link needs a whole-number P1545; "2a" gives no link`.
  - `no English label → { skip: 'no_title' }; a 501-character label → { skip: 'no_title' }`.
  - `genreTag('science fiction film') → { name: 'science fiction', slug: 'science-fiction' }`.
  - `mapRef: Q5 human → person, otherwise organization`.
  - `a book maps P50 to author and P1104 to attributes.pageCount, with subtype null`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** `feat(api): map Wikidata items to AMDB works`.

### Task 6: The import runner

**Files:**
- Create: `apps/api/src/features/imports/wikidata/run.ts`.
- Modify: `apps/api/src/features/imports/repository.ts`. Add `findByWikidataIds(qids: string[]): Promise<Map<qid, { id: string; kind: EntityKind }>>` (active `external_id` relations, scheme `wikidata`), and `databaseBytes(): Promise<number>` (`SELECT pg_database_size(current_database())`).
- Test: `apps/api/test/wikidata-run.test.ts`, driving the whole pipeline with a fake `fetch` over fixtures into PGlite.

**Interfaces:**
- Consumes: Tasks 1, 3, 4 and 5. Uses the existing tag lookup by slug (`changes` repository `findTagBySlug`), through a new imports-service method rather than a cross-feature repository call.
- Produces:
  - `runWikidataImport(deps: { db; client: WikidataClient; measureBytes?: () => Promise<number>; today?: Date; log?: (line: string) => void }, opts: { classes: string[]; minSitelinks: number; limit: number; maxDbBytes: number; batchSize?: number /* 50 */ }): Promise<{ runId: string; status; stats: ImportStats }>`
  - `ImportStats`:
    - `candidates`
    - `imported`
    - `skipped: Record<'present' | 'no_title' | 'duplicate_external_id' | 'missing', number>`
    - `linksAdded`
    - `bytesStart`
    - `bytesEnd`
    - `bytesPerWork`
    - `stoppedAt` (rank reached)
  - Steps of a run:
    1. Start a run.
    2. Discover candidates and take the first `limit`.
    3. For each batch, check the size cap first. Once `measureBytes() >= maxDbBytes`, the run is `capped`.
    4. Fetch the batch's entities.
    5. Fetch referenced creators, series, franchises and genres not yet known, then reuse them by `wikidata` id or tag slug.
    6. Each work becomes one `importSubmission`: its create, the creates for new references, its relations, and its external ids. A 409 `duplicate_external_id` retries once with only the `wikidata` id. Present works are skipped.
    7. Links whose target is missing are kept, then added in a final pass as relate-only submissions.
    8. `finishRun` with stats. A `WikidataUnavailable` makes the run `failed`, with the error message, and committed works stay.

- [ ] **Step 1: Write the failing tests:**
  - `imports three films that share a director: one creator, three work_creator links, and wikidata ids on all four`.
  - `a second run imports nothing new and creates no duplicate creators`: `stats.skipped.present === 3`.
  - `a sequel_of link to a work later in the same run is added in the final pass`.
  - `the size cap stops before the next batch and the run is capped`: `measureBytes` returns over the cap after batch 1.
  - `two items sharing an IMDb id: the second is imported with only its wikidata id`.
  - `Wikidata down mid-run: the run is failed with the reason, and the first batch's works remain`.
  - `limit takes the most-linked candidates first`.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the API suite. Expect PASS.
- [ ] **Step 5: Commit** `feat(api): run a Wikidata import into the catalog`.

### Task 7: CLI and runbook

**Files:**
- Create: `apps/api/scripts/import-wikidata.ts`.
- Modify: `apps/api/package.json`. Add the script `"import:wikidata": "tsx scripts/import-wikidata.ts"`.
- Create: `docs/import.md`.
- Test: `apps/api/test/import-cli.test.ts` (argument parsing only).

**Interfaces:**
- Produces:
  - `parseArgs(argv: string[]): { classes; minSitelinks; limit; maxDbBytes; dryRun }`.
  - Defaults:
    - `classes`: all five
    - `minSitelinks`: `5`
    - `limit`: `1000`
    - `maxDbBytes`: `3_500_000_000`
    - `dryRun`: `false`
  - It rejects unknown flags.
  - `--dry-run` discovers, fetches and maps, and prints counts plus 3 sample records. It writes nothing and doesn't need `DATABASE_URL`.
  - The script reads `DATABASE_URL` (`openDb` runs migrations), runs the import, prints the stats as one JSON line, and exits 0 for `finished` or `capped` and 1 for `failed`.

- [ ] **Step 1: Write the failing tests** for `parseArgs`: the defaults, `--limit 50 --classes Q11424,Q7725634 --max-db-bytes 1000`, and that `--bogus` throws.
- [ ] **Step 2: Run.** Expect FAIL.
- [ ] **Step 3: Implement.** Write `docs/import.md`:
  1. Dry run locally.
  2. Import 1,000 into a local Postgres and read `bytesPerWork`.
  3. Production: `railway run --service postgres` gives `DATABASE_PUBLIC_URL`. Run `DATABASE_URL=$DATABASE_PUBLIC_URL pnpm --filter @amdb/api import:wikidata --limit N` with N from step 2, keeping the projection under 70% of the volume. This step needs the owner's go-ahead.
  4. Check the site, then raise `--limit` on later runs. Runs are additive.
  5. Upgrade to Railway Pro and grow the volume before the projection passes 3.5 GB.
- [ ] **Step 4: Run** `pnpm check` at the root. Expect PASS. Then run the real `pnpm --filter @amdb/api import:wikidata --dry-run --limit 20` against live Wikidata, and expect the counts and 3 sane records. This is the first contact with the real source. Fix the mapping if the samples are wrong, and add the case to Task 5's tests.
- [ ] **Step 5: Commit** `feat(api): import:wikidata CLI and runbook`.

---

## Deferred follow-ups (2026-11-06)

Set aside during review, none blocking. The ones that matter before a large `--limit` come first.

- A hard-killed run (kill -9, a dropped connection, a second Ctrl-C) stays `running` and blocks the
  next run until it's closed by hand (docs/import.md). A CLI flag to close a stale run would help.
- `importSubmission` checks the run is `running` before its transaction, not inside it: one extra
  round trip per work over the public proxy.
- The CLI's signal wiring and the dry run's entity-chunking loop have no automated test (checked by
  hand).
- `GET /api/import-runs/{id}` for a `running` run (`finishedAt: null`) is no longer tested.
- `tagBySlug` ignores the tag's kind, so a genre can attach to a human-made non-genre tag with the
  same slug.
- The web `authorName` declares its own author union instead of the generated type.
- The client: concurrent calls aren't serialized (the runner is serial by contract); two ids
  redirecting to one item drop one; a 400 is reported as "unavailable"; a final
  `WikidataUnavailable` carries no `cause`; one cast lacks its own why-comment.
- Discovery accepts negative or fractional sitelink counts from the service (the query's floor
  excludes them in practice).
- `candidateQids` includes candidates later skipped, so their references are dropped too, and it
  also filters genre QIDs.
- The architecture test's "no catalog writes" check for the imports repository is a heuristic.
