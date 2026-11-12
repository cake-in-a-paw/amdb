# Language-Neutral Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Wikidata importer reads `mul` aliases after `en` ones. `--backfill` appends them to lists that only imports ever set, without racing a person's edit.

**Architecture:**
- **Mapping:** `map.ts` builds one uncapped en-then-mul list per item. Creates cap it at 50.
- **Blocked lists:** the imports repository replaces "any change touched the list" with "a list is blocked". A list is blocked when anything other than an import set it, or it was merged, redacted or reverted.
- **Append:** the backfill appends to the stored list.
- **Race guard:** the changes service's `importSubmission` takes an optional guard. Inside the write's transaction, the guard locks the entities and re-checks the lists before anything applies.

**Tech Stack:** TypeScript, Hono, Drizzle, PGlite tests (vitest).

**Spec:** `docs/superpowers/specs/2026-11-11-mul-aliases-design.md`, which amends `docs/superpowers/specs/2026-11-11-alternate-titles-design.md`.

## Global Constraints

- The constitution `CLAUDE.md` 0.2.0 binds:
  - every catalog write goes through `features/changes/apply.ts`;
  - tests run against PGlite with the real migrations, with no module mocks;
  - every cast or non-null `!` outside tests carries a why-comment;
  - features change each other's data only through services;
  - no dead code: `findNamesTouched` is replaced, not kept alongside.
- No migration. No change to search, the web app, merges or redaction.
- Aliases:
  - `en` aliases first, in Wikidata's order, then `mul` aliases;
  - each is trimmed and 1–500 characters (`MAX_TITLE`);
  - deduped with `dedupeNames` against the main and original title and earlier names.
- A `mul` alias is kept only if every `\p{L}` character in it is `\p{Script=Latin}`. `en` aliases aren't filtered.
- `ALTERNATE_NAMES_MAX` (50) applies to the stored list after the append, and to a create's list.
- The backfill only appends: it never removes or reorders a name.
- A list that wouldn't change gets no revision.
- `namesAdded` keeps its meaning: works and creators given a names update.
- American spelling.
- Commits:
  - Conventional, lowercase subject of at most 100 characters, scope `api` (`docs:` for docs);
  - signed with `git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$HOME/.ssh/id_claude_signing.pub" commit -S`;
  - ending with the attribution trailers.
  - Never `git add -A`, never bare `git stash`.

## Review Focus

1. A list the first names backfill set from `en` gains its `mul` aliases, and a second backfill reports `namesAdded: 0`. (Task 3)
2. A moderator reverts the import's names change, and the backfill leaves the list alone. A revert of the same work's title edit doesn't block names. (Task 2, Task 3)
3. A person edits a creator's list after the backfill read it but before the write. The person's list survives, and the skip is logged. (Task 3)
4. A list at 50 gets nothing, and a list at 48 gets two. A `mul` alias isn't lost to `en` aliases the list already holds. (Task 3)
5. A Cyrillic `mul` alias is dropped while a Latin one with accents and digits ("Zoë 2") is kept. (Task 1)

---

### Task 1: en-then-mul alias list

**Files:**
- Modify: `apps/api/src/features/imports/wikidata/map.ts`:
  - replace `englishAliases`, around lines 234–240;
  - update `mapWork`, around line 256, and `mapRef`, around line 313.
- Test: `apps/api/test/wikidata-map.test.ts`

**Interfaces:**
- Produces:
  - **`aliasNames`:** `aliasNames(entity: WikidataEntity, main: (string | null | undefined)[]): string[]`, uncapped.
  - **Uncapped lists for the backfill:** `WorkRecord` gains `aliases: string[]`, and `mapRef`'s return gains `aliases: string[]`. Both hold the uncapped list.
  - **Capped lists for creates:** `fields.alternateTitles` and `alternateNames` stay the list capped at 50, and stay absent when it's empty.
  - **`isLatinScript`:** `isLatinScript(s: string): boolean`, exported for tests.
- Consumed by Task 3: `rec.aliases` and `refItems.get(qid)?.ref?.aliases`.

- [ ] **Step 1: Write failing tests**
  - `aliasNames` on an entity with `en: ['Alpha One']` and `mul: ['Alpha One', 'Zoë 2', 'Альфа', 'ALPHA']`, with main `['Alpha']`, gives `['Alpha One', 'Zoë 2']`:
    - the duplicate of the `en` alias is dropped;
    - the Cyrillic alias is dropped;
    - `'ALPHA'` normalizes to the main title, so it's dropped.
  - `isLatinScript('Samuel L. Clemens')` and `isLatinScript('Zoë 2')` are true. `isLatinScript('Альфа')` and `isLatinScript('Mark 黄')` are false. `isLatinScript('1984')` is true, since it has no letters.
  - **Uncapped vs. capped:** for a work with 30 `en` and 30 `mul` distinct Latin aliases:
    - `mapWork(...).aliases` has length 60, ending with the `mul` ones;
    - `fields.alternateTitles` has length 50.
  - **Creators:** `mapRef` on a person with only `mul: ['Samuel Clemens']` gives `alternateNames: ['Samuel Clemens']` and `aliases: ['Samuel Clemens']`.
- [ ] **Step 2: Run** `pnpm --filter @amdb/api test wikidata-map`. Expected: FAIL, because `aliasNames` isn't defined.
- [ ] **Step 3: Implement**
  - `aliasNames` and `isLatinScript`, with the `\p{L}`/`\p{Script=Latin}` test using the `u` flag.
  - Rewire `mapWork` and `mapRef`. Delete `englishAliases`.
  - Update the docblock to say "en then mul".
- [ ] **Step 4: Run** `pnpm --filter @amdb/api test`. Expected: all tests pass. Existing alias tests are unchanged, because their fixtures have no `mul`.
- [ ] **Step 5: Commit** `feat(api): read mul aliases after english ones`

### Task 2: blocked lists, current lists, and the write guard

**Files:**
- Modify: `apps/api/src/features/imports/repository.ts`. Replace `findNamesTouched` (around lines 179–213), and add `findNameLists` and `lockAndReadNames`.
- Modify: `apps/api/src/features/imports/service.ts`. Pass the new queries through, and add `assertNamesOpen`.
- Modify: `apps/api/src/features/changes/service.ts`, `importSubmission` (around line 587).
- Test: `apps/api/test/imports.test.ts`

**Interfaces:**
- **Types:** `type NamesKey = 'alternateTitles' | 'alternateNames'` and `type NamesExpectation = { entityId: string; key: NamesKey; names: string[] }`, exported from `features/imports/service.ts`.
- **`findNamesBlocked`:** `findNamesBlocked(entityIds: string[], key: NamesKey): Promise<Set<string>>` on the imports repository and service. It replaces `findNamesTouched`. An id is blocked when any of the following holds:
  - a create or update has `payload ? key` and its submission has `import_run_id IS NULL`, in any status;
  - a create or update on it was redacted, whatever its source;
  - it was merged into or out of, using the same three merge lookups as today and the 0011 indexes;
  - a change whose `payload->>'revertOf'` names a change on this entity whose payload has `key` exists, in any status.
- **`findNameLists`:** `findNameLists(kind: 'work' | 'creator', entityIds: string[]): Promise<Map<string, string[]>>` returns the stored list.
- **`assertNamesOpen`:** `assertNamesOpen(expected: NamesExpectation[]): Promise<void>` on the imports service.
  - It locks the entities' rows (`SELECT … FROM entities WHERE id IN (…) ORDER BY id FOR UPDATE`).
  - It re-reads the lists and re-runs `findNamesBlocked`.
  - It throws `conflict('names_changed', …)` (409) when an entity is now blocked, or its list differs from `names` element by element.
  - It does nothing for an empty array.
- **`importSubmission`:** `importSubmission(runId, changes, opts?: { namesOpen?: NamesExpectation[] })`. When `namesOpen` is non-empty, it calls `createImportsService(tx).assertNamesOpen(opts.namesOpen)` first inside its transaction. If `tx` isn't typed as `Db`, keep the cast or adapter minimal and give it a why-comment.

- [ ] **Step 1: Write failing tests** in `imports.test.ts`, using the existing setup and publish helpers:
  - **Import-only list:** a work whose list only an import run set is not blocked.
  - **Person's edit:** after a person's approved names edit, it is blocked. A pending one blocks too.
  - **Revert of names:** a moderator's revert of the import's names change blocks.
  - **Unrelated revert:** a revert of a person's title edit on the same work doesn't block.
  - **Lists:** `findNameLists('work', [id])` returns the stored list.
  - **Guard:** `assertNamesOpen` rejects with code `names_changed` after a person changes the list. It resolves when the list is unchanged.
- [ ] **Step 2: Run** `pnpm --filter @amdb/api test imports`. Expected: FAIL, because `findNamesBlocked` isn't defined.
- [ ] **Step 3: Implement.**
  - Delete `findNamesTouched` and switch its two callers in `run.ts` (around lines 625 and 632) to `findNamesBlocked`, with no other change in behavior yet.
  - Keep the queries batched per call, as today.
- [ ] **Step 4: Run** `pnpm --filter @amdb/api test`. Expected: all tests pass.
- [ ] **Step 5: Commit** `feat(api): let imports extend name lists only imports set`

### Task 3: backfill appends `mul` aliases under the guard

**Files:**
- Modify: `apps/api/src/features/imports/wikidata/run.ts`:
  - the batch setup, around lines 615–650;
  - the names block and retry loop, around lines 494–552.
- Modify:
  - `docs/import.md` §6, the backfill paragraph, the `namesAdded` line, and the cost note for a second pass;
  - `docs/superpowers/specs/2026-11-05-wikidata-importer-design.md`, the alias row at line 47 and the backfill rule around lines 97–110, to match the new rule.
- Test: `apps/api/test/wikidata-run.test.ts`

**Interfaces:**
- Consumes:
  - `rec.aliases` and `ref.aliases` (Task 1);
  - `findNamesBlocked`, `findNameLists`, `NamesExpectation` and `importSubmission(..., { namesOpen })` (Task 2).
- Behavior:
  - **What to append:** for each list that isn't blocked, `stored ++ dedupeNames([...main, ...stored], aliases)`, truncated so the total is at most 50. If the result equals `stored`, there's no update.
  - **Writing:** each names update sends the whole new list, and adds `{ entityId, key, names: stored }` to `namesOpen`.
  - **Conflict:** a `names_changed` 409 is handled exactly like `duplicate_name` today. Drop `names`, log `dropped names for <qid>: names_changed (...)` and keep the rest of the submission.

- [ ] **Step 1: Write failing tests** next to the existing names backfill tests (around line 1633):
  - **mul fixtures:** add a `mulAliased(e, ...values)` helper beside `aliased`.
  - **Optional hook:** add an optional async hook to `fakeWikidata`, `onEntities(ids)`, awaited before it responds.
  - **Second-pass append:**
    - Import `Q1` with `en` alias 'Alpha One', then backfill once with `withAliases`. The list is `['Alpha One']`.
    - Backfill with `Q1` also carrying `mul: ['Alpha Prime', 'Альфа']`. The result is `['Alpha One', 'Alpha Prime']` and `namesAdded` is at least 1.
    - A third backfill reports `namesAdded: 0`.
  - **Revert blocks:** a moderator reverts the backfill's names update on Alpha. A `mul` backfill leaves Alpha at `[]`.
  - **Unrelated revert:** a moderator reverts a person's title edit on Alpha. A `mul` backfill still appends.
  - **Cap:**
    - Stored at 48 names, with 3 new `mul` aliases: it ends at 50, holding the first 2.
    - Stored at 50: no update, and no new change row for Alpha.
  - **Race:**
    - The `onEntities` hook fires on the call that fetches the director Q200, which happens after the batch read. It publishes a person's `alternateNames: ['Mine']` edit for Dana Director.
    - After the backfill:
      - Dana Director's list is `['Mine']`;
      - the log contains `names_changed`;
      - the run still finishes;
      - the film whose submission conflicted keeps its other changes and loses only its names for this run.
  - **Existing tests:** the cleared, reverted, pending and redacted tests keep passing unchanged.
- [ ] **Step 2: Run** `pnpm --filter @amdb/api test wikidata-run`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the backfill changes and update both docs**, then run `pnpm check` in full.
- [ ] **Step 4: Commit:** `feat(api): append mul aliases in the backfill, guarded against edits` and `docs: describe mul aliases in the importer docs`.
