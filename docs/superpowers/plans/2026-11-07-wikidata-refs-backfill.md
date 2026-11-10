# Wikidata References Backfill Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add the creators, series, franchises, genre tags and work links that imported works are
missing, without touching anything else.

**Why:** Before 6b9101e the importer read only Wikidata's `en` label. A reference (director, studio,
series, franchise, genre) whose name exists only under `mul` was dropped while its work still went
in; and a work link whose target work was skipped (no title) was never added. The first production
runs (films `8a7ea7d4…`, TV `6a45699c…`) imported 716 films and 995 series that way. Re-runs skip
`present` works, so they never get the references.

**Architecture:** A backfill mode of the existing runner, so it reuses discovery, fetching, mapping,
reference resolution and the run record. `runWikidataImport(deps, { ...opts, backfill: true })`
walks the same ranked candidates, but acts only on works that are already present, and for each one
submits a relate-only (plus reference-creates) submission through `changes.importSubmission`, the
same revision-logged path (constitution III). It never creates or edits the work itself.

**Spec:** `docs/superpowers/specs/2026-11-05-wikidata-importer-design.md` (the importer). This plan
extends it; add a short "Backfill" section to that spec in the same change.

## Global Constraints

- Every write goes through `changes.importSubmission(runId, …)` and is attributed to a new import run
  (`params.backfill: true`). No direct table writes (III; `features/changes/apply.ts` owns writes).
- Additive only: never update fields, never unrelate, never touch external ids.
- **A removal sticks:** skip a relation if `relations` holds *any* row (live or removed, i.e. any
  `removed_by_change`) with the same `type`, `from_id`, `to_id` and, for `work_creator`, `role`.
  So a moderator's unrelate is never undone, and nothing is duplicated.
- Only works whose `create` change came from an import run (`submissions.import_run_id IS NOT NULL`)
  are backfilled. Works a person entered are left alone, even if they carry a wikidata id.
- Only live works (not removed or reverted). A merged loser is not backfilled.
- Reference resolution is the runner's existing rules, unchanged: works win (`candidateQids`), a QID
  held as another kind or removed is dropped, a retracted tag's slug is dropped, one QID in two roles
  keeps the first. A reference created by the backfill gets its wikidata external id, as in a normal run.
- Same politeness, size cap, abort/interrupt, one-run-at-a-time and failure handling as a normal run.
- Feature folders and layers (VIII): new queries live in `features/imports/repository.ts` (reads
  only) behind `features/imports/service.ts`; casts carry why-comments (IX); no catch-and-continue
  beyond the runner's existing per-item rule (XI); delete nothing you don't replace (XIII).
- Tests on PGlite through the existing `test/wikidata-run.test.ts` helpers; only Wikidata is faked (VI).
- American spelling. Conventional commits, scope `api` (docs commits use `docs:`).

## Review Focus

1. A moderator unrelated a creator from an imported work → the backfill must not re-add it.
2. A work whose relation already exists live → nothing submitted for it (no empty submission either).
3. A present work entered by a person (no import run) → untouched.
4. A work that now has no missing references → counted as up to date, not as an error.
5. A reference QID that is itself a candidate work (works win) → still dropped in backfill.

---

### Task 1: Backfill mode in the runner, plus CLI flag and docs

**Files:**
- Modify: `apps/api/src/features/imports/wikidata/run.ts`
- Modify: `apps/api/src/features/imports/repository.ts`, `apps/api/src/features/imports/service.ts`
- Modify: `apps/api/scripts/import-wikidata-args.ts`, `apps/api/scripts/import-wikidata.ts`
- Modify: `docs/import.md`, `docs/superpowers/specs/2026-11-05-wikidata-importer-design.md`
- Test: `apps/api/test/wikidata-run.test.ts`, `apps/api/test/import-cli.test.ts`

**Interfaces:**
- `RunOptions` gains `backfill?: boolean` (default false). Recorded in the run's `params`.
- `WikidataImportStats` gains, in backfill runs, `backfilled` (works that got ≥1 new relation),
  `upToDate` (present imported works with nothing missing) and `relationsAdded`; `imported` stays 0.
  A non-imported (person-entered) present work counts in `skipped.present`. Absent works (not yet
  imported) count in a new `skipped.not_present` key. Keep `SkipReason` the single list of keys.
- Imports service/repository: a read that, for a set of work entity ids, returns which were created by
  an import-run submission; and a read that returns the existing relation keys (type, from, to, role),
  live or removed, touching those works.
- CLI: `--backfill` flag; `--dry-run --backfill` is rejected with a clear error (dry run stays a plain
  mapping preview).

- [ ] **Step 1: Write the failing tests** in `test/wikidata-run.test.ts`, one `it` each:
  - a work imported while its director had only a `mul` label (simulate: import with the director
    missing from the fake's entities, then backfill with it present) gains the `work_creator` relation
    and the creator is created with its wikidata external id; stats `{ backfilled: 1, relationsAdded: 1 }`;
    the run's params include `backfill: true`.
  - genre, series and franchise references and a work link (target imported after the source) are each
    backfilled.
  - a relation a moderator unrelated is not re-added (`relationsAdded: 0`, `upToDate: 1`).
  - a second backfill adds nothing (`upToDate` = number of works).
  - a person-entered work with a wikidata id is untouched (`skipped.present: 1`).
  - a candidate that isn't in AMDB is not imported (`skipped.not_present: 1`, `imported: 0`).
  - `--backfill` parses; `--dry-run --backfill` throws.
- [ ] **Step 2: Run them, watch them fail** (`pnpm --filter @amdb/api exec vitest run test/wikidata-run.test.ts`).
- [ ] **Step 3: Implement.** Factor the reference-resolution half of `buildChanges` so a normal run and
  a backfill share it (the backfill passes the existing work's id in place of `{ ref: 'w' }` and emits no
  work create, no work external ids). In the batch loop, backfill mode fetches and maps the *present*
  works instead of the fresh ones, filters each record's relations against the existing-relation keys,
  and submits only when something remains. Deferred links work as in a normal run.
- [ ] **Step 4: Run the API suite and `pnpm check`;** all green.
- [ ] **Step 5: Docs.** `docs/import.md`: a "Backfill references" section with the production command
  (same `railway ssh` pattern, `--backfill --limit N --classes …`) and what it does and never does.
  Spec: a short "Backfill" section stating the rules above.
- [ ] **Step 6: Commit** (signed, see the dispatch for the exact command).

## Deferred follow-ups (2026-11-07)

Accepted for the first backfill run; revisit if moderation activity grows.

- ~~A fully reverted reference (creator, series, property) loses its live wikidata id, so a backfill,
  like a normal run, can create it again and relate it.~~ Fixed 2026-11-09: retired reference QIDs
  are dropped like removed ones.
- ~~A merge repoints only live relations, so a removed W→C1 keeps C1's id; after C1 merges into C2 a
  backfill can add W→C2.~~ Fixed 2026-11-09: the key check also resolves each row's ends through
  `merged_into_id`.
- A reference a person added by hand without a wikidata id is not recognized, so the backfill adds a
  second entity for it. Same as a normal run.
- The work-link key ignores `linkType`: an existing A→B link of one type blocks another type
  (conservative; the merge dedup key includes it).
- The works-win guard in `entityRef` is redundant today (candidates never reach `refItems`); kept as
  a safety net, so no test can make it decide anything.
