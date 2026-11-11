# Alternate Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Works carry `alternateTitles` and creators `alternateNames`: editable, searchable, imported
from Wikidata English aliases, backfilled, and unioned on merge.

**Architecture:** Two `text[]` columns plus a JS-normalized, newline-joined `*_norm` text column
each (a generated column can't call `array_to_string`, which isn't immutable). Works get a second
generated tsvector, `alt_search`, over the norm text with its own GIN index; creators match it with
`like`, as names do today. Every write still goes through `features/changes/apply.ts`; the merge
case writes the winner's union and records the previous list in the `unmerge` inverse. The importer
reads `aliases`; the backfill adds a field `update` only where no change ever touched the field.

**Tech Stack:** TypeScript, Hono + zod-openapi, Drizzle on Postgres 18 (PGlite 0.5.12 in tests),
React + TanStack Router, vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-alternate-titles-design.md`

## Global Constraints

- Constitution `CLAUDE.md` binds: III (writes only via `features/changes/apply.ts`), VI (PGlite;
  only external services faked, through injected deps), VIII (feature folders and layers), IX
  (casts and `!` get why-comments; value lists and field shapes in `@amdb/shared`), X (committed
  migration, never edit an applied one), XI (one error shape), XIII (delete what you replace).
- Field names exactly `alternateTitles` (works) and `alternateNames` (creators); each name is the
  existing `title` rule (`z.string().trim().min(1).max(500)`).
- `ALTERNATE_NAMES_MAX = 50` limits submitted lists only. Merges keep every name, so the zod field
  shape and the database carry no count limit.
- A name is a duplicate when `normalizeTitle(name)` equals the normalized main title, original title
  (works), or an earlier name. Submissions with one get 400 `duplicate_name`; over 50 get 400
  `too_many_names`. The check runs only when a change sets the list.
- English aliases only (`aliases.en`). Series, properties and tags are untouched.
- Imports and backfill write a list only if no change in the entity's history ever had the field
  key in its payload and no merge ever went into it.
- Search: a result matched only through alternate names sorts after every main/original match.
- American spelling. Conventional commits, scopes `api|web|shared|db|adr|ci`; docs use `docs:`.
  Commits signed with the on-disk key (the dispatch gives the command). `pnpm check` green before
  each task's last commit.
- OpenAPI snapshot is regenerated, never hand-edited:
  `pnpm --filter @amdb/api openapi:dump > apps/api/test/fixtures/openapi.snapshot.json` then
  `pnpm --filter @amdb/shared gen:api`.
- Dumps: none exist yet, so "every view" means the API (entity `fields`) and the web. A future dump
  serves what the API serves (V) and needs nothing from this plan.
- No production run in this plan. The backfill runs later, with the owner's go-ahead.

## Review Focus

1. A title edit approved after a names edit makes a name equal to the new title: the list stays as
   is, and the work page and search still work (Task 2 test `title edit leaves a now-duplicate name`).
2. Editing a different field of a merged entity holding more than 50 names succeeds (Task 4 test
   `edit after a large merge`).
3. A search page boundary falls between main-title and alias-only results: the next page neither
   repeats nor skips a result (Task 3 test `cursor crosses into alias matches`).
4. A pending names edit exists when the backfill runs: the backfill leaves the entity alone (Task 6
   test `pending edit counts as touched`).
5. A draft saved before this change (no names key) still loads in the form (Task 7 test
   `old draft loads`).

---

### Task 1: Shared field shapes and name rules

**Files:**
- Create: `packages/shared/src/names.ts`
- Modify: `packages/shared/src/fields.ts`, `packages/shared/src/index.ts`
- Delete: `apps/api/src/features/catalog/normalize.ts` (move `normalizeTitle`; update its four importers)
- Test: `packages/shared/test/names.test.ts`, `packages/shared/test/fields.test.ts`

**Interfaces:**
- Produces: `normalizeTitle(s: string): string` (moved verbatim), `ALTERNATE_NAMES_MAX = 50`,
  `dedupeNames(main: (string | null | undefined)[], names: string[]): string[]` (keeps first
  occurrences in order, drops names equal to a main title or an earlier name after normalization,
  trims), `duplicateNameIndex(main, names): number` (index of the first duplicate, or -1),
  `joinNorms(names: string[]): string` (normalized names joined by `\n`, `''` for none).
- `WorkFieldsBase.alternateTitles` and `CreatorFields.alternateNames`: `z.array(title).optional()`;
  both are in `UpdateFieldsFor` via the existing `.partial()`.

- [ ] **Step 1: Write failing tests**

```ts
test('dedupeNames drops title matches and repeats', () => {
  expect(dedupeNames(['Nineteen Eighty-Four', null], ['1984', 'nineteen  eighty-four', ' 1984 ', 'Ninéteen Eighty-Four']))
    .toEqual(['1984']);
});
test('duplicateNameIndex finds the first duplicate', () => {
  expect(duplicateNameIndex(['Seven'], ['Se7en', 'SEVEN'])).toBe(1);
  expect(duplicateNameIndex(['Seven'], ['Se7en'])).toBe(-1);
});
test('joinNorms', () => expect(joinNorms(['Mark Twain', 'Twain'])).toBe('mark twain\ntwain'));
test('work fields accept alternateTitles', () => {
  expect(WorkFields.safeParse({ mediaType: 'book', subtype: null, title: 'X', alternateTitles: ['Y'] }).success).toBe(true);
  expect(WorkFields.safeParse({ mediaType: 'book', subtype: null, title: 'X', alternateTitles: [''] }).success).toBe(false);
});
```

- [ ] **Step 2:** `pnpm --filter @amdb/shared test` — FAIL (`dedupeNames` not exported).
- [ ] **Step 3:** Implement `names.ts`, add the fields, export from `index.ts`, move `normalizeTitle`
  and point `catalog/service.ts`, `changes/service.ts`, `changes/apply.ts`, `imports/wikidata/run.ts`
  at `@amdb/shared`.
- [ ] **Step 4:** `pnpm test` — PASS.
- [ ] **Step 5:** Commit `feat(shared): add alternate name fields and rules`.

### Task 2: Storage, writes and submission checks

**Files:**
- Modify: `apps/api/src/platform/db/schema.ts`, `apps/api/src/features/changes/apply.ts` (`writeRow`
  86-155, `DERIVED` 57), `apps/api/src/features/catalog/service.ts` (`DERIVED` 18),
  `apps/api/src/features/changes/service.ts` (create check ~270, update check ~300)
- Create: migration `apps/api/drizzle/0010_alternate_names.sql` via `pnpm --filter @amdb/api db:generate`
- Regenerate: OpenAPI snapshot and `packages/shared/src/api/schema.ts`
- Test: `apps/api/test/alternate-names.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Columns: `works.alternate_titles text[] not null default '{}'`, `works.alternate_titles_norm text
  not null default ''`, `works.alt_search tsvector generated always as (to_tsvector('simple',
  alternate_titles_norm)) stored` with GIN index `works_alt_search_idx`;
  `creators.alternate_names text[] not null default '{}'`, `creators.alternate_names_norm text not
  null default ''`. Drizzle names `alternateTitles`, `alternateTitlesNorm`, `altSearch`,
  `alternateNames`, `alternateNamesNorm`; the norm and search columns join both `DERIVED` sets.
- `writeRow` writes the list (`?? []`) and `joinNorms(list)`. Entity responses then show
  `fields.alternateTitles` / `fields.alternateNames` (always present, `[]` when empty).
- Errors: 400 `duplicate_name` (details `{ field, index }`) and 400 `too_many_names`, raised in the
  changes service when a create or update payload has the key; an update compares against the
  entity's current title and original title merged with the payload.

- [ ] **Step 1: Write failing tests** (drive the HTTP API with `setupTest()`):
  `create with names shows them`, `update replaces the list`, `revert restores the previous list
  exactly` (set `['A','B']`, then `['C']`, revert → `['A','B']` and `fieldSources.alternateTitles`
  back to the first change), `duplicate of title is 400 duplicate_name` (title "Nineteen Eighty-Four",
  names `['Nineteen eighty-four']`, `details.index === 0`), `51 names is 400 too_many_names`,
  `title edit leaves a now-duplicate name` (names `['1984']`, then title → `'1984'`: 200, list still
  `['1984']`), and the same create/update/duplicate trio for a creator's `alternateNames`.
- [ ] **Step 2:** `pnpm --filter @amdb/api test alternate-names` — FAIL.
- [ ] **Step 3:** Schema, migration, `writeRow`, `DERIVED`, service checks.
- [ ] **Step 4:** Regenerate the snapshot and client types; `pnpm test` — PASS.
- [ ] **Step 5:** Commit `feat(api): store and edit alternate names`.

### Task 3: Search and duplicate check

**Files:**
- Modify: `apps/api/src/features/catalog/repository.ts` (`search` 66-102, `existingMatching` 175-199),
  `apps/api/src/features/catalog/service.ts` (search cursor encoding, ~194)
- Test: `apps/api/test/search.test.ts`, the duplicate-check tests (wherever `existingMatching` is
  covered today)

**Interfaces:**
- `search` adds `works.alt_search @@ tsquery` and `creators.alternate_names_norm like pattern` to the
  `or`. A rank expression is `1` when the row matched only through those two, else `0`; order is
  `rank, titleExpr, id`. `SearchCursor` becomes `{ rank: 0 | 1; title: string; id: string }`, and the
  cursor comparison `(rank, titleExpr, id) > (...)`.
- `existingMatching` adds `works.alternate_titles_norm like pattern` and
  `creators.alternate_names_norm like pattern`. `pendingMatching` is unchanged.

- [ ] **Step 1: Write failing tests:** `"1984" finds the novel after the films` (films titled
  "1984" from 1956 and 2023, book "Nineteen Eighty-Four" with names `['1984']`: order film, film,
  book); `"mark twain" finds Samuel Clemens`; `cursor crosses into alias matches` (limit 1 paging
  through the three works returns each once, in order); `duplicate check matches an alternate
  title` (typing "1984" for a book lists the novel); `a pending create's names are not matched`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test` — PASS.
- [ ] **Step 5:** Commit `feat(api): search alternate names`.

### Task 4: Merges union names

**Files:**
- Modify: `apps/api/src/features/changes/apply.ts` (`InverseSchema` 18-44, merge case 332-395,
  `assertUndoable` merge case ~460, `applyInverse` unmerge ~565-588)
- Test: `apps/api/test/merge.test.ts`

**Interfaces:**
- For work and creator merges, before the inverse is built: winner list =
  `dedupeNames([winner.title, winner.originalTitle], [...winner.list, loser.title, loser.originalTitle, ...loser.list])`
  (creators: `name`, no original). Write it through the same column path as `writeRow`, without
  re-parsing the whole row, and set the winner's `fieldSources[key] = change.id`.
- The `unmerge` inverse gains optional `intoNames: { key: 'alternateTitles' | 'alternateNames';
  value: string[]; source: string | null }`. Unmerge writes `value` back and restores or deletes the
  source. `assertUndoable` throws `stale_change` if the winner's current source for that key isn't
  the merge change.
- `parseFields` on later edits must accept lists over 50 (the zod shape has no max; Task 1).

- [ ] **Step 1: Write failing tests:** `merging a creator unions names` (Mark Twain with `['Twain']`
  into Samuel Clemens with `[]` → Clemens `['Mark Twain', 'Twain']`, and searching "mark twain" finds
  Clemens); `unmerge restores the winner's list and source exactly`; `unmerge after a names edit is
  stale_change`; `work merge adds title and original title, deduped`; `edit after a large merge`
  (merge two creators with 30 names each, then update the winner's description: 200).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `pnpm test` — PASS.
- [ ] **Step 5:** Commit `feat(api): union alternate names on merge`.

### Task 5: Importer reads English aliases

**Files:**
- Modify: `apps/api/src/features/imports/wikidata/client.ts` (`props` 152; `WikidataEntity.aliases?:
  Record<string, { value: string }[]>`), `map.ts` (`WorkRecord.fields.alternateTitles`, `mapWork`
  225-282, `mapRef` 284-296), `run.ts` (`referenceChanges` creator fields 241-243)
- Docs: `docs/superpowers/specs/2026-11-05-wikidata-importer-design.md` (mapping: aliases)
- Test: `apps/api/test/wikidata-map.test.ts`, `wikidata-run.test.ts`, `wikidata-client.test.ts`

**Interfaces:**
- `mapWork` sets `alternateTitles = dedupeNames([title, originalTitle], aliases.en).slice(0, 50)`,
  omitted when empty. `mapRef` returns `alternateNames` for creators the same way (key omitted when
  empty); `referenceChanges` puts it in the creator `create`.

- [ ] **Step 1: Write failing tests:** `maps English aliases, dropping the title` (Q208460-like
  entity: label "Nineteen Eighty-Four", aliases `['Nineteen Eighty-Four by George Orwell', '1984',
  'nineteen eighty-four']` → `['Nineteen Eighty-Four by George Orwell', '1984']`); `ignores non-English
  aliases`; `creator create carries alternateNames`; `client requests aliases`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `pnpm test` — PASS.
- [ ] **Step 5:** Commit `feat(api): import english aliases`.

### Task 6: Backfill adds names to untouched entities

**Files:**
- Modify: `apps/api/src/features/imports/repository.ts` (+ service passthroughs), `run.ts`
  (`backfillWork` 441-497, stats 31-58 and 156), `docs/import.md`, importer spec "Backfill" section
- Test: `apps/api/test/wikidata-run.test.ts`

**Interfaces:**
- `findImportedCreators(qids: string[]): Promise<Map<string, string>>` (QID → creator id): live,
  unmerged creators whose `create` and live wikidata id share an import-run submission, like
  `findImportedWorks` (112).
- `findNamesTouched(entityIds: string[], key: 'alternateTitles' | 'alternateNames'):
  Promise<Set<string>>`: ids with any change of any status whose payload has `key` (create:
  `payload->'fields'`, update: the payload object itself; check the stored shape), or any merge
  whose `into` is the id.
- `backfillWork` adds `{ op: 'update', kind: 'work', entityId, fields: { alternateTitles } }` when
  the record has names and the work is untouched, and the same for each referenced creator from
  `findImportedCreators` that is untouched and whose mapped ref has names. These count toward the
  "nothing to add" check. New stat `namesAdded` (entities given names), backfill runs only.

- [ ] **Step 1: Write failing tests:** `backfill adds names to an imported work and its creator`;
  `cleared list is never refilled` (a person sets `[]` → backfill leaves `[]`); `reverted to empty
  is never refilled`; `pending edit counts as touched`; `merged winner is touched`;
  `person-entered creator is left alone`; `second backfill is up to date`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement; document `namesAdded` and the relaxed rule.
- [ ] **Step 4:** `pnpm test` — PASS.
- [ ] **Step 5:** Commit `feat(api): backfill alternate names`.

### Task 7: Web: edit and show names

**Files:**
- Modify: `apps/web/src/components/entry-form.tsx`, `work-fields.tsx`, `form-fields.tsx`,
  `src/lib/submission.ts` (`toFields` 123, `toInputs` 147, `fieldErrors` 276), `src/lib/entity-form.ts`,
  `src/lib/labels.ts`, `src/lib/diff.ts` / `components/change-diff.tsx`, `components/work-page.tsx`,
  `components/list-page.tsx` (creator page)
- Test: `apps/web/test/edit.test.tsx`, `submit.test.tsx`, `work-page.test.tsx`, `diff.test.ts`,
  `drafts.test.tsx`

**Interfaces:**
- Form state stays strings: a textarea `NamesField` labeled "Also known as" with hint "One name per
  line", key `alternateTitles` / `alternateNames`. `toFields` splits lines, trims, drops blanks, runs
  `dedupeNames` against the form's title and original title, and sends the array (an edit that
  empties it sends `[]`). `formFromEntity` joins with `\n`. More than 50 lines shows "At most 50
  names" and blocks submit.
- Pages show "Also known as: A · B" under the title when the list is non-empty. Diffs render a list
  as its names joined by ", ".

- [ ] **Step 1: Write failing tests:** `edit adds a name and submits the array`; `duplicate lines and
  the title are dropped before submit`; `51 lines blocks submit`; `work page shows Also known as`;
  `creator page shows Also known as`; `diff shows lists`; `old draft loads`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` — PASS.
- [ ] **Step 5:** Commit `feat(web): edit and show alternate names`.
