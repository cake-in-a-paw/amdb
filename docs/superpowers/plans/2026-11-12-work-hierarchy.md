# Work Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TV seasons and episodes become works under one parent work. They are linked by a `work_part` relation with an optional number. Contributors edit them through submissions, the API and web show the tree, and a Wikidata `--parts` mode imports every season and episode of the shows AMDB holds.

**Architecture:**
- **Storage:** the parent link is a relation (`work_part`, from parent to child, `position` = number), not a column. Merges, reverts, history and `has_dependents` therefore work as they do for any relation.
- **Tree list:** which subtypes may be parts of which is one list in `@amdb/shared`.
- **Guards in `apply.ts`:**
  - the list is checked under lock on relate, restore, subtype or media-type update, merge and unmerge;
  - a partial unique index guards one parent per child.
- **Reads:**
  - the entity view gains `parent`, `ancestors` and `partCount`;
  - parts come from a paged endpoint;
  - search, browse, related and duplicates leave parts out unless asked.
- **Importer:** `--parts` walks the shows AMDB holds, one submission per season.

**Tech Stack:** TypeScript, Hono + zod-openapi, Drizzle on Postgres 18 (PGlite in tests), React + TanStack Router/Query, vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-work-hierarchy-design.md` (approved 2026-11-12). It is the authority; this plan only adds the decisions it leaves to the builder.

## Global Constraints

- **Constitution `CLAUDE.md` 0.2.0 binds every task:**
  - I: a privacy rule is tested from outside, as someone who shouldn't see the data.
  - II: Wikidata (CC0) is the only source. TMDB ids are stored only as Wikidata holds them.
  - III: every write is a revision, imports included.
  - IV: nothing submitted is hard-deleted.
  - V: API, browser and dumps serve one dataset. No dumps exist yet, so a future dump serves what the API serves.
  - VI: tests drive HTTP against PGlite with the real migrations. Only Wikidata is faked, through the injected client.
  - VIII: feature folders and three layers. Every catalog write is in `features/changes/apply.ts`.
  - IX: every cast or `!` outside tests gets a why-comment. Value lists live once in `@amdb/shared`.
  - X:
    - every schema change is a committed migration, and an applied migration is never edited;
    - value lists are `text` with `CHECK`s, never Postgres `ENUM`s;
    - a unique-index violation becomes a 409, never a 500.
  - XI: one error shape. Clients render loading, error and empty states.
  - XIII: delete what you replace.
- **OpenAPI snapshot:** regenerated, never hand-edited. Run `pnpm --filter @amdb/api openapi:dump > apps/api/test/fixtures/openapi.snapshot.json`, then `pnpm --filter @amdb/shared gen:api`.
- **Value lists (exact):**
  - `Subtype` gains `season` and `episode`;
  - `RelationType` gains `work_part`;
  - `IdScheme` gains `tmdb_season` (`P12558`) and `tmdb_episode` (`P12559`);
  - no `music` media type in this release.
- **Tree list:**
  - `film_tv`: `season` under `series` or `anime_series`; `episode` under `season`, `series` or `anime_series`;
  - a part has its parent's media type, and root subtypes never have a parent;
  - music (`track` under `album | single | ep`) and games (`expansion`, `dlc` under `game`; `dlc` under `expansion`) are rows added later, not in this release.
- **Position:** optional, a whole number from 0 to 2147483647.
- **Errors:**
  - `400 invalid_tree` at plan time, `409 invalid_tree` at apply: the tree list is broken, or a work would be its own part;
  - `409 has_parent`: a second live parent;
  - `409 conflicting_parents`: a merge of two works with different parents;
  - `400/409 invalid_relation`: `series_work` or `property_work` to a work whose subtype is a part subtype.
- **What counts as a part:** a work whose subtype is a part subtype (`season`, `episode`), whether attached or not.
  - Parts are out of default search, browse, related groups and the duplicate check, and never listed as roots.
  - Decided: test the subtype, not the presence of a parent. That keeps orphans and parts of removed shows out too, with no join.
- **Parts order:** by position, then parts with no position, then a `season` numbered 0. Ties break by release date, title, then id.
- **Import:**
  - the parts import credits only live AMDB creators, never creates one, and adds no tags, work links (`P155`/`P156`) or series memberships (`P179`);
  - the size cap is checked between submissions, so no episode lands without its season and show;
  - no production run in this plan; it needs the owner's go-ahead at that moment.
- **Spelling and commits:**
  - American spelling;
  - Conventional Commits with a lowercase subject of at most 100 characters, scopes `api|web|shared|db`, and `docs:` for docs;
  - signed with `git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$HOME/.ssh/id_claude_signing.pub" commit -S`, ending with the session's attribution trailers;
  - stage named paths only. Never `git add -A`, never bare `git stash`;
  - `pnpm test` before each commit, and `pnpm check` before each task's last commit.

## Review Focus

1. **A second parent through two pending relates.** Two pending relates name the same episode, each from a different season. Approving the second answers `409 has_parent`, never 500. (Task 2, `second pending parent is 409 on approve`)
2. **Reverting a detach after a move.** An episode is detached, then attached elsewhere, and then the detach is reverted. The revert answers `409 has_parent`, never 500. (Task 2, `revert of a detach after a move is 409`)
3. **A parts page boundary between groups.** A page ends between numbered, unnumbered and season-0 parts. Paging with `limit=1` returns each part once, in order. (Task 4, `parts cursor crosses every group`)
4. **`includeParts=false`.** It behaves like no filter, not like `true`. (Task 5, `includeParts=false hides parts`)
5. **An edit draft from before this release.** A draft saved with no `parent` key still loads in the form. (Task 7, `old draft without parent loads`)

---

### Task 1: Value lists, tree rules, migration and decision record

**Files:**
- Create: `packages/shared/src/parts.ts`; `packages/shared/test/parts.test.ts`
- Modify:
  - `packages/shared/src/values.ts`: `Subtype` (line 14), `RelationType` (28–35), `IdScheme` (44);
  - `packages/shared/src/index.ts`.
- Modify: `apps/api/src/platform/db/schema.ts`, the `relations` indexes at lines 348–358.
- Create the migration `apps/api/drizzle/0012_work_parts.sql`:
  - generate it with `pnpm --filter @amdb/api db:generate --name work_parts`;
  - then, before it is ever applied, append the `CHECK` swap by hand. Decided: one migration, since `relations_type_columns` is hand SQL from `0002` that drizzle doesn't model.
- Modify the web files, since they break typecheck once the lists grow:
  - `apps/web/src/lib/labels.ts`: `subtypeLabels` 19–24, `idSchemeLabels` 41–49;
  - `apps/web/src/components/change-diff.tsx`: `relationWords` 75–82;
  - `apps/web/src/components/history-list.tsx`: `describeRelate` ~33–60;
  - `apps/web/src/components/submission-result.tsx`: `describe` ~26–49.
- Regenerate: the OpenAPI snapshot and `packages/shared/src/api/schema.ts`. `RelationType` and `IdScheme` are in `ChangeInput` and `externalIds`.
- Docs:
  - Create `docs/decisions/0007-work-parts-as-relations.md` from template `0000`. It records the relation-not-column decision, with rmd's `parent_id`/`root_id` columns as the rejected option.
  - Amend `docs/superpowers/specs/2026-11-02-amdb-design.md` §4.1 (the Series bullet, line 87) and §11 (line 311): seasons, episodes and tracks are works under a parent, not series entries.
- Test: `packages/shared/test/parts.test.ts`, `apps/api/test/schema.test.ts`

**Interfaces:**
- **Produces in `@amdb/shared`:**
  - `PART_OF` (`satisfies Partial<Record<MediaType, Partial<Record<Subtype, readonly Subtype[]>>>>`) holds the film_tv rows from Global Constraints. A doc comment names the music and games rows to come.
  - `PART_SUBTYPES: readonly Subtype[]`, derived from `PART_OF`'s keys: `['season', 'episode']`.
  - `ZERO_LAST_SUBTYPES: readonly Subtype[] = ['season']`.
  - `isPartSubtype(subtype: Subtype | null): boolean`.
  - `type WorkShape = { mediaType: MediaType; subtype: Subtype | null }`.
  - `canBePartOf(child: WorkShape, parent: WorkShape): boolean`. True only when the media types match and `PART_OF[mediaType][child.subtype]` includes `parent.subtype`.
- **Database:**
  - `relations_type_columns` gains the arm `WHEN 'work_part' THEN "to_id" IS NOT NULL`, which leaves `position` optional. The other arms stay verbatim from `0002`;
  - unique index `relations_one_parent` on `(to_id)` where `type = 'work_part' AND removed_by_change IS NULL`;
  - index `relations_parts_idx` on `(from_id, position)` with the same predicate;
  - both are declared in `schema.ts`.
- **Web words:**
  - `season: 'Season'`, `episode: 'Episode'`, `tmdb_season: 'TMDB (season)'`, `tmdb_episode: 'TMDB (episode)'`;
  - for `work_part`: "Part of a work" in the diff, "Added as a part" plus ` at no. N` in history, and "Part of X" plus `, no. N` in the submission result.

- [ ] **Step 1: Write failing tests**
  - `canBePartOf` cases:
    - `{film_tv, season}` under `{film_tv, series}` is true;
    - `{film_tv, episode}` under `{film_tv, season}` and under `{film_tv, anime_series}` is true;
    - `{film_tv, season}` under `{film_tv, season}` is false;
    - `{film_tv, movie}` under `{film_tv, series}` is false;
    - `{film_tv, episode}` under `{book, null}` is false.
  - `isPartSubtype('episode')` is true. `isPartSubtype('series')` and `isPartSubtype(null)` are false.
  - In `schema.test.ts`, with the existing `rejects` helper:
    - two live `work_part` rows to one child fail on `"relations_one_parent"`;
    - after the first is retired (`removed_by_change` set), a second succeeds;
    - a `work_part` with a null `to_id` fails on `"relations_type_columns"`;
    - one with a null `position` is accepted;
    - one with position 0 is accepted.
- [ ] **Step 2:** `pnpm --filter @amdb/shared test parts` and `pnpm --filter @amdb/api test schema`. Expected: FAIL (`canBePartOf` isn't exported, and the index doesn't exist).
- [ ] **Step 3:** Implement the lists, `parts.ts`, the schema indexes and the migration. Add the web words, then write the ADR and the design-spec amendment.
- [ ] **Step 4:** Regenerate the snapshot and client types, then run `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(db): add work_part relation, part subtypes and tree rules`, then `docs: record work parts as relations`.

### Task 2: Relate, update and restore rules for parts

**Files:**
- Modify: `apps/api/src/features/changes/schemas.ts`. Line 31 changes `position` to `.min(0)`. Decided: 0 is allowed for every type, since a series "book 0" prequel is real, and it is one rule instead of two.
- Modify: `apps/api/src/features/changes/service.ts`:
  - `Resolved` 72–78;
  - `RELATION_RULES` 81–96;
  - `lookupEntity` 248–263;
  - the create `refs.set` 316–321;
  - the relate case 364–418.
- Modify: `apps/api/src/features/changes/repository.ts`:
  - `findEntity` 96–110 also returns `subtype`;
  - add `findParentLink`.
- Modify: `apps/api/src/features/changes/apply.ts`:
  - the update case 336–366;
  - the relate case 367–395;
  - `set_fields` 622–633;
  - `restore_relation` 643–646;
  - the new helpers sit near `requireEntities`, 268–283.
- Test: `apps/api/test/work-parts.test.ts`

**Interfaces:**
- Consumes: `canBePartOf`, `isPartSubtype` (Task 1).
- `RELATION_RULES.work_part = { from: ['work'], to: 'work', required: [], allowed: ['position'] }`.
- `Resolved` gains `subtype: Subtype | null`. A pending create reads it from its payload, as `mediaType` is read today.
- `changesRepository.findParentLink(childId: string, except: string[] = []): Promise<string | null>` returns the relation id of the child's live `work_part`.
- **Plan-time checks (relate `work_part`):**
  - `from` is `to` → 400 `invalid_tree`;
  - `!canBePartOf(to, from)` → 400 `invalid_tree`, with details `{ parentSubtype, childSubtype }`;
  - `findParentLink(to.id, freed)` → 409 `has_parent` with details `{ relationId }`. `freed` is the relation ids of earlier `unrelate`s in the same submission, as for external ids, so a move (unrelate, then relate) is one submission;
  - `series_work` or `property_work` whose `to` has a part subtype → 400 `invalid_relation`.
- **In `apply.ts`:**
  - `assertTree(tx: Tx, workId: string): Promise<void>` reads the work's row, its live parent link and its live children. It throws `conflict('invalid_tree', …, { workId, relationId })` when:
    - any link fails `canBePartOf`;
    - or the work has a part subtype and a live `series_work` or `property_work`.
  - `lockWithParent(tx: Tx, workId: string): Promise<typeof entities.$inferSelect>`. The lock rule (decided):

```ts
// Every tree check holds the lock of the work's parent. A parent-side write already holds its own
// lock, and every child-side write takes the parent's, so a parent subtype change and a child
// relate or subtype change serialize. Locks are taken in id order, as requireEntities does.
// It replaces the update case's initial `requireEntity`; it never follows it, or a relate locking
// parent then child could deadlock with it. The work must be live; its parent is locked with a
// plain row lock, live or not, as in Task 3, so a part under a removed show can still be edited.
for (;;) {
  const before = await parentIdOf(tx, workId);            // unlocked read
  for (const id of [workId, before].filter(Boolean).toSorted()) await lockRow(tx, id);
  if ((await parentIdOf(tx, workId)) === before) break;   // re-read under lock; retry if it moved
}
return requireEntity(tx, workId);                         // already locked: resolves and checks it's live
```

- **Where the checks run:**
  - relate `work_part`: `requireEntities` locks both ends as today; after the insert, `assertTree(tx, to)`;
  - relate `series_work` or `property_work` to a part: 409 `invalid_relation`;
  - update, and the `set_fields` inverse, of a work whose keys include `mediaType` or `subtype`: `lockWithParent` in place of the first `requireEntity`, then `assertTree` after `writeRow`;
  - `restore_relation` of a `work_part`:
    - lock both ends in id order with `lockRow`;
    - a removed or retracted parent → 409 `entity_unavailable`, the code `lockPair` uses. Decided: a revert never re-attaches a part to a work no one can see;
    - then the restore inside `writeUnique`, then `assertTree(tx, toId)`.
- **`lockRow(tx: Tx, id: string): Promise<void>`:** `select … for update` on `entities` by id, with no liveness filter. Task 3 uses it for parents too.
- **Unique violations:** `writeUnique`'s duplicate callback maps a `work_part` violation to `has_parent`, with the holder's relation id from `findParentLink`.

- [ ] **Step 1: Write failing tests** (`setupTest()`, `publish`/`submit`, a moderator):
  - `show, season and episode relate and read back`: show → season at position 2, then season → episode at position 14. A second episode with no position is accepted.
  - `episode 0 and season 0 are accepted`: position 0 gives 201.
  - `film as part of a series is 400 invalid_tree`.
  - `episode under a movie is 400 invalid_tree`.
  - `work as its own part is 400 invalid_tree`.
  - `second parent is 409 has_parent`: the episode is under season A, then a relate from season B.
  - `move in one submission`: unrelate the A link and relate B in one submission gives 201, and B is the parent.
  - `second pending parent is 409 on approve`: two pending relates for one episode from A and from B. Approve A, then approve B: 409 `has_parent`, and B stays pending.
  - `revert of a detach after a move is 409`: detach from A, attach to B, then revert the detach: 409 `has_parent`.
  - `subtype change that breaks the tree is refused`:
    - a season with an episode, updated to `subtype: 'movie'`: approve gives 409 `invalid_tree`;
    - an episode updated to `mediaType: 'book', subtype: null` gives the same.
  - `pending relate then subtype change`: publish a season's change to `movie`, then approve a pending episode relate under it: 409 `invalid_tree`.
  - `revert restores a subtype only if the tree allows`: the update to `series` is applied, a season is attached under it, and the update is reverted: 409 `invalid_tree`.
  - `part under a removed show can still be edited`: an admin removes the show, and then two changes are both applied (200): an update of the season carrying `subtype: 'season'` and a new description, which takes the `lockWithParent` path, and an episode relate under the season.
  - `series membership of a part is invalid_relation`: `series_work` to an episode at plan time is 400.
  - `revert a show's create waits for its parts`: revert of the show's create is 409 `has_dependents` until the part relates are reverted, then 200.
  - `rejecting a pending show rejects its pending part links`:
    - the submission holds the show, season and episode creates and both relates, all pending;
    - rejecting the show's create rejects both relates;
    - the season and episode creates stay pending. See Plan notes 1.
- [ ] **Step 2:** `pnpm --filter @amdb/api test work-parts`. Expected: FAIL (`work_part` isn't in `RELATION_RULES`).
- [ ] **Step 3:** Implement as in Interfaces.
- [ ] **Step 4:** `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): guard the work tree on relate, update and restore`.

### Task 3: Merges keep the tree whole

**Files:**
- Modify: `apps/api/src/features/changes/apply.ts`:
  - the merge case, 406–467;
  - `lockPair`, 479–490;
  - the `unmerge` case of `applyInverse`, 647–676.
- Test: `apps/api/test/work-parts-merge.test.ts`

**Interfaces:**
- Consumes: `assertTree` and `has_parent` (Task 2).
- **Merge case:**
  - **Locking:** the loser, the winner and both live parents (from each one's live `work_part` link) are locked in one id-ordered pass. The parents are locked live or not, with a plain `for update` row lock, since a removed show must not block. Re-read the parent links after locking, and retry if they changed.
  - **Different parents:** both have a live parent, the parents differ, and neither parent is the other merge end → 409 `conflicting_parents`, details `{ fromParent, intoParent }`. This runs before any repoint.
  - **After the repoint loop:** `assertTree(tx, intoId)`. A violation becomes 409 `invalid_tree` and rolls the merge back.
  - **Unchanged:** the same-parent duplicate drop through `relationKey` (position ignored), and the inverse shape.
- **Unmerge:** after relations are restored, `assertTree` on `from` and on `into`. A unique violation while restoring maps to `has_parent`.

- [ ] **Step 1: Write failing tests**
  - `merging two copies of a show gathers seasons`:
    - shows A and B each have "Season 1", with two episodes each;
    - merge B into A, and A has both seasons;
    - merge B's Season 1 into A's Season 1, and that season has all four episodes. B's season link was dropped as a duplicate.
  - `unmerging in reverse order restores the tree exactly`. Revert the season merge, then the show merge. Each work's parent and position, and each show's parts, equal the state before the merges, read from the API.
  - `unmerging the show first is 409, not 500`. Revert the show merge while the season merge is live: 409 `stale_change`.
  - `merging episodes under different seasons is 409 conflicting_parents`. No relation changes.
  - `merging a season into a film is 409 invalid_tree`. The season has episodes, and the target is a `movie`.
  - `merge into a work without a parent gives it the loser's parent`. Unmerge takes the parent away again.
  - `same-parent merge drops the loser's number; unmerge restores it`. The same parent, with the loser at position 3 and the winner with none: the loser's link is dropped as a duplicate. Assert the winner's position is unchanged (none), and that unmerge brings the loser back at position 3. This pins the existing "drop ignores position" rule.
- [ ] **Step 2:** `pnpm --filter @amdb/api test work-parts-merge`. Expected: FAIL (`conflicting_parents` isn't raised; today the index gives a 500).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): keep the work tree whole across merges`.

### Task 4: Read API: parent, ancestors and paged parts

**Files:**
- Modify: `apps/api/src/features/catalog/schemas.ts`: `SummarySchema` 8–14 and `EntitySchema` 25–70; add `PartsQuery`, `PartsCursor` and `PartsSchema`.
- Modify: `apps/api/src/features/catalog/repository.ts`:
  - `activeRelations` 39–45;
  - `worksOfHubs` 143–181;
  - add `parentLinks`, `workRows`, `parts` and `partCount`.
- Modify: `apps/api/src/features/catalog/service.ts`: `getEntity` 97–201; add `ancestry` and `parts`.
- Modify: `apps/api/src/features/catalog/routes.ts`: add `partsRoute`.
- Regenerate: the snapshot and client types.
- Test: `apps/api/test/parts-read.test.ts`, `apps/api/test/related.test.ts`

**Interfaces:**
- **`AncestorSchema`:** `{ id: uuid, title: string, subtype: Subtype.nullable(), position?: int, removed: boolean }`. `position` is the ancestor's own number under its parent. A removed ancestor keeps its id and stored title (the `[removed]` placeholder), and `removed: true`.
- **`EntitySchema.relations` gains, for works only:**
  - `parent: { relationId, work: SummarySchema, position?: int, removed: boolean } | null`;
  - `ancestors: AncestorSchema[]`, root first, with the parent last and `[]` for a root;
  - `partCount: int`, the live, listed parts.
- **Repository:**
  - `parentLinks(childIds: string[]): Promise<{ childId: string; relationId: string; parentId: string; position: number | null }[]>` reads live `work_part` rows with no `listed()` filter;
  - `workRows(ids: string[])` returns `{ id, title, subtype, mediaType, releaseYear, removed }` with no `listed()` filter;
  - `parts(parentId: string, after: PartsCursor | null, limit: number)` returns listed children, with `limit + 1` rows;
  - `partCount(parentId: string): Promise<number>`.
- **`ancestry(workId)`:** walks `parentLinks` upward, with at most 8 levels as a guard against corrupt data.
- **`activeRelations(id)`:** leaves out `work_part` rows whose `from_id` is `id`. A show's parts are never loaded unbounded. The child's own parent link isn't loaded there either; `ancestry` reads it.
- **`worksOfHubs`:** adds `works.subtype IS NULL OR works.subtype NOT IN PART_SUBTYPES`. Decided: no part fills a "More by" or series group.
- **`GET /api/entities/{id}/parts`:**
  - query `PartsQuery = { cursor?: string, limit: 1–100, default 50 }`;
  - answers 200 with `PartsSchema = { items: { relationId, work: SummarySchema, subtype: Subtype.nullable(), position?: int }[], nextCursor: string | null }`;
  - 308 for a merged id, 404 for an unknown or retracted one, and 410 `removed` for a removed one, as `getEntity` does;
  - a non-work answers `items: []`.
- **Parts order and cursor:** the algorithm the tests don't pin. `PartsCursor = { b, p, y, m, d, t, id }`.

```sql
-- r = live work_part rows from the parent; w = the child's works row
b = CASE WHEN r.position IS NULL THEN 1
         WHEN r.position = 0 AND w.subtype IN (ZERO_LAST_SUBTYPES) THEN 2 ELSE 0 END
p = coalesce(r.position, 0)
y = coalesce(w.release_year, 10000); m = coalesce(w.release_month, 13); d = coalesce(w.release_day, 32)
t = w.title;  id = r.to_id
ORDER BY b, p, y, m, d, t, id   -- the cursor compares (b, p, y, m, d, t, id) > (...) with no NULLs in play
```

- [ ] **Step 1: Write failing tests**
  - `episode shows its parent and ancestors`:
    - the episode at position 14 under "Season 2" (position 2) under the show;
    - `relations.parent.work.title === 'Season 2'`, with `position: 14`;
    - `ancestors` is the show (no position), then Season 2 (`position: 2`);
    - `removed` is false on each.
  - `root has no parent`: `parent: null`, `ancestors: []`.
  - `show's entity view has partCount, not its parts`: a show with 3 seasons gives `partCount: 3`, and no season appears anywhere in `relations`.
  - `parts listed in order`:
    - seasons at positions 2, 1 and 0, plus one with no position. The order is 1, 2, no position, 0;
    - under a season, episodes at 0, 1 and 2 list as 0, 1, 2.
  - `ties break by date then title`: two parts with no position, dated 2009 and 2008, list as 2008, then 2009.
  - `parts cursor crosses every group`: with the five seasons above, `limit=1` paging returns each once, in that order.
  - `parts of a removed show still resolve`:
    - an admin removes the show;
    - the season's page answers 200 with `parent.removed: true` and the parent id;
    - the show's `/parts` answers 410.
  - `parts of a merged id redirect`: 308 with `Location` set to the winner's `/parts`.
  - `More by leaves out parts` (in `related.test.ts`): a director credited on a film and on 3 episodes. The film's `byCreator` group lists no episode.
- [ ] **Step 2:** `pnpm --filter @amdb/api test parts-read related`. Expected: FAIL.
- [ ] **Step 3:** Implement, then regenerate the snapshot and types.
- [ ] **Step 4:** `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): show a work's parent chain and page its parts`.

### Task 5: Search, browse and duplicate check leave parts out

**Files:**
- Modify: `apps/api/src/features/catalog/schemas.ts`: `SearchQuery` 73–85 and `DuplicatesQuery` 105–114; `SummarySchema` gains `part`.
- Modify: `apps/api/src/features/catalog/repository.ts`: `search` 68–114, `browse` 117–136 and `existingMatching` 187–215.
- Modify: `apps/api/src/features/catalog/service.ts`: `search` 204–212 and `duplicates` 229–244.
- Regenerate: the snapshot and client types.
- Test: `apps/api/test/search.test.ts`, `apps/api/test/browse.test.ts`, and the duplicate-check tests in `apps/api/test/entities.test.ts` (wherever `/api/duplicates` is covered today)

**Interfaces:**
- Consumes: `PART_SUBTYPES` (Task 1); `parentLinks`, `workRows` and `AncestorSchema` (Task 4).
- **`includeParts`:**
  - `SearchQuery` gains `includeParts: z.enum(['true', 'false']).optional()`. Decided: not `z.coerce.boolean()`, which reads `"false"` as true;
  - the repository filter gets `includeParts: boolean`;
  - without it, the filter adds `works.subtype IS NULL OR works.subtype NOT IN PART_SUBTYPES` (non-work rows have a null subtype).
- **Browse:** always leaves parts out, with no flag.
- **Search results:** `SummarySchema.part?: { position?: int, ancestors: AncestorSchema[] }`. It is set on search results when `includeParts` is true and the work has a live parent. One `parentLinks` and `workRows` pass per level per page, never per row.
- **Duplicate check:**
  - `DuplicatesQuery` gains `parentId?: uuid`, with kind `work` only (same refine as `mediaType`);
  - with `parentId`, `existingMatching` matches only the live, listed parts of `resolveWinner(parentId)`;
  - without it, it leaves part subtypes out;
  - `pendingMatching` is unchanged and never filtered by parent. Decided: filtering pending creates by parent would itself reveal which parent a pending part sits under (constitution I).

- [ ] **Step 1: Write failing tests**
  - `"Pilot" finds the film, not the episode`: a film "Pilot" and an episode "Pilot". The default search returns only the film.
  - `includeParts=true adds the episode with its context`: the episode's `part.ancestors` titles are `[show, season]`, and `part.position` is 1.
  - `includeParts=false hides parts`: the same results as no flag.
  - `includeParts=yes is 400`.
  - `browse lists no seasons or episodes`: browsing `kind=work&mediaType=film_tv` lists the show only.
  - `an orphaned season stays out of search and browse`.
  - `duplicate check among siblings`:
    - two shows each have an episode "Pilot";
    - `duplicates?kind=work&title=Pilot&parentId=<seasonA>` lists only A's;
    - without `parentId`, `existing` lists neither episode.
  - `pending part reveals only four fields` (constitution I, as an anonymous caller):
    - a contributor's pending submission creates an episode "Pilot" and its `work_part` under season A;
    - `duplicates?…&parentId=<seasonB>` and `…&parentId=<seasonA>` both list it in `pending`, so its presence doesn't depend on the parent;
    - each pending entry's keys are exactly `['kind', 'mediaType', 'releaseYear', 'title']`.
- [ ] **Step 2:** `pnpm --filter @amdb/api test search browse entities`. Expected: FAIL.
- [ ] **Step 3:** Implement, then regenerate the snapshot and types.
- [ ] **Step 4:** `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): keep parts out of default search, browse and duplicates`.

### Task 6: Web: breadcrumbs, parts list and search context

**Files:**
- Create: `apps/web/src/lib/parts.ts`, `apps/web/src/components/part-breadcrumbs.tsx` and `apps/web/src/components/parts-list.tsx`.
- Modify:
  - `apps/web/src/components/work-page.tsx`, which renders both new components;
  - `apps/web/src/routes/search.tsx`, which gains the toggle and search param;
  - `apps/web/src/components/entry-row.tsx`, whose title uses the part context;
  - `apps/web/src/components/relation-picker.tsx`, which gains the `includeParts` prop.
- Test: `apps/web/test/work-page.test.tsx`, `apps/web/test/search.test.tsx`, `apps/web/test/parts.test.ts`

**Interfaces:**
- Consumes: Task 4's `parent`, `ancestors`, `partCount` and `/parts`; Task 5's `includeParts` and `Summary.part`.
- Produces: `RelationPicker` gains `includeParts?: boolean`, which sends `includeParts: 'true'` to `/api/search` (consumed by Task 7).
- **`partLabel(subtype: Subtype | null, position: number | undefined, ancestors: Ancestor[]): string`:**
  - season: `Season N`, `Specials` for 0, and `Season` with no position;
  - episode whose parent is a season with position S: `S{S}E{N}` (`S{S}E?` without its own number);
  - episode directly under a show: `Episode N` (`Episode` with no number);
  - anything else: `''`.
- **`partTitle(summary)`:** a card title.
  - An episode shows `{root} · {label} · {title}`, as in "Breaking Bad · S1E1 · Pilot".
  - A season shows `{root} · {label}`. Decided: a season's own title usually repeats the show's.
  - A non-part shows its title.
- **`PartBreadcrumbs`:**
  - a `nav` with `aria-label="Part of"`, linking each ancestor and showing the work last, as text;
  - a removed ancestor is the text "a removed work", with no link;
  - a work with a part subtype and no parent shows "Not attached to a show".
- **`PartsList`:**
  - `useInfiniteQuery` on `/parts` with `limit: 50`, using the existing `LoadMore`, `Loading` and `LoadError`;
  - hidden when `partCount === 0`;
  - the heading is "Seasons" when every loaded item is a season, "Episodes" when every one is an episode, else "Seasons and episodes";
  - rows are `EntryRow`s titled `partLabel`, plus ` · title` for non-seasons.
- **Search:**
  - `validateSearch` adds `parts?: true`;
  - a checkbox "Include seasons and episodes" toggles it and sends `includeParts: 'true'`.

- [ ] **Step 1: Write failing tests**
  - `parts.test.ts` checks `partLabel`:
    - a season at 2 is `Season 2`, and at 0 is `Specials`;
    - an episode at 14 under a season at 2 is `S2E14`;
    - an episode at 5 under a show is `Episode 5`.
  - `episode page shows breadcrumbs`: a `navigation` named "Part of" links "Breaking Bad" and "Season 1".
  - `show page lists its seasons in order`: a list under the heading "Seasons" holds "Season 1", "Season 2", "Specials", in that order.
  - `a long season loads more`: 60 episodes (seeded by an import-style submission), with 50 shown, then "Load more" shows 60.
  - `parts list error state`: the `/parts` request fails (the harness's failing-fetch helper, as `entity-states.test.tsx` does), and "Retry" is shown.
  - `orphaned season says so`: the text "Not attached to a show".
  - `search hides episodes until asked`: "Pilot" lists the film only. Ticking "Include seasons and episodes" adds "Breaking Bad · S1E1 · Pilot".
- [ ] **Step 2:** `pnpm --filter @amdb/web test work-page search parts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): show a work's place in its show and list its parts`.

### Task 7: Web: attach, move, renumber and detach a part

**Files:**
- Modify: `apps/web/src/lib/submission.ts`:
  - `EntryForm` 37–46;
  - `isEntryForm` 65–79;
  - `emptyForm` 81–91;
  - `pickedEntries` and `relationChanges` 240–275;
  - `validateForm` ~383.
- Modify:
  - `apps/web/src/lib/entity-form.ts` 9–24;
  - `apps/web/src/lib/diff.ts`, `buildEdit` 58–98;
  - `apps/web/src/lib/rebase.ts` 85–97 and `isEditDraft` 100;
  - `apps/web/src/components/work-fields.tsx`, a new section beside series at 266–290;
  - `apps/web/src/components/duplicate-check.tsx`, which passes `parentId`.
- Test: `apps/web/test/edit.test.tsx`, `apps/web/test/submit.test.tsx`, `apps/web/test/drafts.test.tsx`, `apps/web/test/submission.test.ts`

**Interfaces:**
- Consumes: `isPartSubtype` (Task 1); `relations.parent` (Task 4); `RelationPicker`'s `includeParts` (Task 6).
- **Form state:**
  - `EntryForm.parent: (Row & { entity: Picked; position: string })[]`, which holds 0 or 1 rows;
  - `upgradeForm(v: unknown): unknown` in `submission.ts` sets `parent: []` when the key is absent;
  - it is applied before `isEntryForm` wherever a draft is read: the `useDraft` validators and `isEditDraft`'s `base` and `form`.
- **Changes sent:**
  - `relationChanges` emits `relate('work_part', endpoint(parent.entity), entry, position ? { position: Number(position) } : {})`;
  - `buildEdit` diffs `parent` with `rowChanges`, keeping it unchanged when `Number(a.position || NaN)` equals `Number(b.position || NaN)` or both are blank;
  - a move or renumber is an `unrelate` plus a `relate` in one submission, which Task 2's `freed` rule accepts.
- **The "Part of" section:**
  - shown when the form's subtype `isPartSubtype`;
  - one picker (kind `work`, `includeParts`), labeled "Find the show or season";
  - a "Number" input, hint "Season or episode number; leave blank if none";
  - a remove button.
  - `validateForm` errors `parent.0.position` with "Use a whole number, 0 or more".
- **`formFromEntity`:** maps `relations.parent` to the single row, with its `relationId`. A removed parent still makes a row, so it can be detached.
- **Duplicate check:** `DuplicateCheck` passes `parentId` when the parent row picks an existing entry.

- [ ] **Step 1: Write failing tests**
  - `submit an episode under a season`:
    - the request holds the create;
    - then `{ op: 'relate', type: 'work_part', from: { id: seasonId }, to: { ref: 'entry' }, data: { position: 3 } }`.
  - `edit renumbers a part`: 3 → 4 sends `unrelate` of the old relation, then the new `relate`, with `position: 4`.
  - `edit moves a part`: a new parent sends an unrelate and a relate.
  - `edit detaches a part`: removing the row sends only the `unrelate`.
  - `blank number sends no position`: `data: {}`.
  - `negative number blocks submit`: shows "Use a whole number, 0 or more".
  - `old draft without parent loads` (in `drafts.test.tsx`): a saved form JSON with no `parent` key opens with its fields filled in.
- [ ] **Step 2:** `pnpm --filter @amdb/web test edit submit drafts submission`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): attach, move, renumber and detach parts`.

### Task 8: Wikidata part mapping and placement (pure)

**Files:**
- Create: `apps/api/src/features/imports/wikidata/tree.ts`, holding pure placement with no I/O.
- Modify: `apps/api/src/features/imports/wikidata/map.ts`:
  - `externalIds` 183–211 adds `['P12558', 'tmdb_season', /^[1-9]\d*$/]` and `['P12559', 'tmdb_episode', /^[1-9]\d*$/]`;
  - export `valueSnaks` and `entityId`;
  - add `mapPart` after `mapWork`, around line 312.
- Test: `apps/api/test/wikidata-tree.test.ts`, `apps/api/test/wikidata-map.test.ts`

**Interfaces:**
- **`mapPart(entity: WikidataEntity, subtype: 'season' | 'episode', today: Date): PartRecord | { skip: 'no_title' }`:**
  - built on `mapWork` with candidate `{ qid, sitelinks: 0, mediaType: 'film_tv', subtype }`;
  - `PartRecord = Pick<WorkRecord, 'qid' | 'fields' | 'creators' | 'externalIds'>`. It drops `series`, `franchises`, `genres` and `links`, so `P155`/`P156` give no `sequel_of` and `P179` gives no series membership.
- **`ordinal(claim: Claim): number | null`:** the first value `P1545` qualifier matching `/^\d+$/` and at most 2147483647. Otherwise null, and 0 is allowed.
- **`claimTo(entity, property: string, targetQid: string): Claim | null`:** the entity's non-deprecated claim on `property` whose value is `targetQid`, preferring the `preferred` rank.
- **`firstValueClaim(entity, property: string): Claim | null`:** the first non-deprecated value claim, `preferred` rank first.
- **`hasP1545(claim: Claim): boolean`:** whether the claim has a `P1545` qualifier at all, whatever its value.
- **`listedPosition(parent: WikidataEntity | undefined, childQid: string): { listed: boolean; position: number | null }`:** read from the parent's `P527` claim to the child.
- **`seasonNumber(season: WikidataEntity, showQid: string, show: WikidataEntity | undefined): number | null`:**
  - if `claimTo(season, 'P179', showQid)` passes `hasP1545`, use `ordinal` of it, which may be null;
  - otherwise, `listedPosition(show, season.id).position`.
  - Decided: the child's own qualifier, once present, decides, even when it isn't a whole number. The parent's list is read only when the child has none.
- **`placeEpisodes(input): Placement`:**
  - input:
    - `showQid: string`;
    - `show?: WikidataEntity`;
    - `seasonsOfShow: Map<string, WikidataEntity>`: every fetched item with `P179` → the show;
    - `placedSeasons: Set<string>`: the season QIDs imported now or already in AMDB under this show;
    - `showHasSeasonParts: boolean`: AMDB already holds a season under the show;
    - `episodes: WikidataEntity[]`.
  - `Placement = { placed: { qid: string; parentQid: string; position: number | null }[]; unplaced: string[] }`. In the block below, `place` and `unplaced` push to those two lists.

```ts
// The spec's order (Decided, "Where an episode hangs"). Never guesses: anything else is unplaced.
for (const e of episodes) {
  const own = firstValueClaim(e, 'P4908');                    // preferred rank first
  const q = own ? entityId(own.mainsnak) : null;
  if (q && placedSeasons.has(q)) {                            // 1. its P4908 season, same show, imported
    place(e, q, hasP1545(own) ? ordinal(own) : listedPosition(seasonsOfShow.get(q), e.id).position);
    continue;
  }
  if (q && !seasonsOfShow.has(q)) { unplaced(e); continue; }  // a season of another (or no) show
  const listing = [...placedSeasons].filter((s) => listedPosition(seasonsOfShow.get(s), e.id).listed);
  if (listing.length === 1) {                                 // 2. the one placed season whose P527 lists it
    place(e, listing[0], listedPosition(seasonsOfShow.get(listing[0]), e.id).position);
    continue;
  }
  if (listing.length === 0 && seasonsOfShow.size === 0 && !showHasSeasonParts) {
    const c = claimTo(e, 'P179', showQid);                    // 3. directly under a show with no seasons,
    place(e, showQid, c ? ordinal(c) : null);                 //    by its overall number
    continue;
  }
  unplaced(e);                                                // 4. counted partsUnplaced
}
```

- Decided:
  - a `P4908` season that isn't among this show's `P179` seasons counts as another show's, since the run can't tell "another show" from "no show" without fetching it;
  - two placed seasons listing one episode is unplaced.

- [ ] **Step 1: Write failing tests** (fixtures in the `film()` style; Q-ids from the spec):
  - `season number from P179 qualifier, else the show's P527`. Season Q1582890 with `P179` → Q1079 and `P1545 "1"` gives 1. With no qualifier, the show's `P527` → Q1582890 with `P1545 "1"` also gives 1.
  - `child's ordinal wins over the parent's list`: the child says 2 and the parent's list says 3, giving 2.
  - `non-whole ordinal gives no position`: `"1a"` gives null, even when the parent's list says 1.
  - `season 0 is kept`: `"0"` gives 0.
  - `episode under its P4908 season`: Q14625947 with `P4908` → Q1582890 and `P1545 "1"` is placed under Q1582890 at 1.
  - `episode found by the season's P527`: no `P4908`, and the placed season lists it at 4, giving that season at 4.
  - `episode of a seasonless show by overall number`: `P179` qualifier `"47"`, giving the show at 47.
  - `episode whose P4908 season is another show's is unplaced`.
  - `episode in a show with seasons but none listing it is unplaced`.
  - `two seasons listing one episode is unplaced`.
  - `mapPart drops sequel and series links`:
    - an episode with `P155` and `P179` gives a record with no `links` or `series` key;
    - its `fields.subtype` is `'episode'`;
    - it keeps `P57` as `director` and `P345` as `imdb`.
  - `maps TMDB season and episode ids`: `P12558 "3572"` gives `tmdb_season`, and `P12559 "62085"` gives `tmdb_episode`.
- [ ] **Step 2:** `pnpm --filter @amdb/api test wikidata-tree wikidata-map`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): map and place wikidata seasons and episodes`.

### Task 9: The `--parts` importer mode, its dry run and docs

**Files:**
- Create: `apps/api/src/features/imports/wikidata/parts.ts` with `importParts` (the run body) and `discoverParts` (SPARQL).
- Modify: `apps/api/src/features/imports/wikidata/run.ts`:
  - `WikidataImportStats` 37–65;
  - `RunOptions` 80–93;
  - the stats init 153–175;
  - the dispatch at 774, as `opts.parts ? importParts(ctx) : importCandidates()`;
  - `bytesPerPart` next to `bytesPerWork` at 793.
- Modify:
  - `apps/api/src/features/imports/repository.ts` and `service.ts`: add `findShows`, `findHeldParts` and `findPartsOf`, with service passthroughs;
  - `apps/api/scripts/import-wikidata-args.ts`, for `--parts`;
  - `apps/api/scripts/import-wikidata.ts`, for the parts dry run.
- Docs:
  - `docs/import.md` gains a new §7, "Seasons and episodes";
  - `docs/superpowers/specs/2026-11-05-wikidata-importer-design.md` gains a parts mode next to "Backfill" (line 93) and adds `P12558`/`P12559` to "What it reads".
- Test: `apps/api/test/wikidata-parts.test.ts`, `apps/api/test/import-cli.test.ts`

**Interfaces:**
- **Consumes:**
  - `mapPart`, `seasonNumber`, `placeEpisodes`, `claimTo` and `ordinal` (Task 8);
  - `importSubmission` (existing);
  - `has_parent` and `invalid_tree` (Task 2).
- **Options:**
  - `RunOptions.parts?: boolean`. `--parts` can't be combined with `--backfill`, `--classes` or `--min-sitelinks`; the args parser throws, naming the flag;
  - `--limit` is the most shows, by QID number ascending.
- **Repository:**
  - `findShows(limit: number): Promise<{ id: string; qid: string }[]>`: listed works of subtype `series` or `anime_series` with a live `wikidata` id;
  - `findHeldParts(qids: string[]): Promise<Map<string, { id: string; kind: EntityKind; live: boolean; subtype: Subtype | null; parentId: string | null }>>`;
  - `findPartsOf(parentIds: string[]): Promise<{ parentId: string; id: string; subtype: Subtype | null; position: number | null; titleNorm: string; everHadWikidataId: boolean }[]>`: live, listed children.
- **`discoverParts(client, showQids: string[])`:**
  - runs two queries per batch of at most 50 shows, of this shape (`Q3464665` for seasons, `Q21191270` for episodes):
    `SELECT ?item ?show ?cls WHERE { VALUES ?show { wd:… } ?item wdt:P179 ?show; wdt:P31 ?cls. ?cls wdt:P279* wd:Q3464665 }`;
  - if a batch query fails with `WikidataUnavailable`, it re-asks one show at a time, and a single-show failure fails the run;
  - each item's class is the base class if listed, else its lowest-numbered matching class;
  - an item in both trees is a season.
- **Run body, per show:**
  - fetch the show, its seasons and its episodes;
  - map them with `mapPart`;
  - place seasons under the show by `seasonNumber`, and episodes by `placeEpisodes`.
- **Skips:**
  - an item held as a live non-part work → `partsHeldAsRoot`;
  - held as another kind → `partsSkipped.held_as_other`;
  - a retired QID (`findRetiredWikidataIds`) → `partsSkipped.reverted`, so it stays reverted;
  - already a part → `partsPresent`, never moved. A present season counts as placed only if its `parentId` is the show.
- **Adoption (decided):**
  - a live part of the same parent that never had a wikidata id is adopted when it is the only such part with the same subtype and the same position;
  - when the Wikidata part has no position, it must instead be the only one with the same normalized title;
  - the run relates only its `wikidata` id and changes no field;
  - never for a QID in `findRemovedWikidataIds`;
  - counted as `partsAdopted`.
- **Submissions:**
  - one per season, holding:
    - the season's create, or `{ id }` when it is present or adopted;
    - its `work_part` from the show;
    - its ids and credits;
    - each new episode's create, `work_part` from the season, ids and credits;
  - episodes directly under a show go in submissions of at most 25 episodes. Decided: `importSubmission` has no change cap, and 25 keeps one transaction small;
  - credits only to live creators from `findByWikidataIds`; any other credit counts toward `creditsSkipped`;
  - a submission with nothing new isn't sent;
  - on `duplicate_external_id`, retry once keeping only `wikidata` ids, as `importWork` does;
  - any other item error skips the submission: each part in it counts toward `partsSkipped.invalid`, logged as `skipped parts of <seasonQid>: <code> (<message>)`.
- **Size cap:** `measure()` runs before each submission. At or over `maxDbBytes`, the run logs `capped at <bytes> bytes before <seasonQid>` and finishes `capped`.
- **Stats (parts runs only):**
  - `shows`, `partsFound`, `partsByClass: Record<string, number>`;
  - `partsAdded`, `partsPresent`, `partsAdopted`, `partsHeldAsRoot`, `partsUnplaced`;
  - `partsSkipped: Record<'no_title' | 'held_as_other' | 'reverted' | 'invalid' | 'missing', number>`;
  - `creditsSkipped`, `bytesPerPart`;
  - also `candidates` (shows considered), `stoppedAt` (the show rank) and `bytesStart`/`bytesEnd`. `imported` and `bytesPerWork` stay 0.
- **Dry run:**
  - `--parts --dry-run` needs `DATABASE_URL` and only reads it (`findShows` and `findHeldParts`);
  - it discovers, fetches, maps and places, then prints `{ dryRun: true, parts: true, shows, partsFound, partsByClass, placed, partsUnplaced, partsHeldAsRoot, creditsSkipped }`;
  - the bytes per part come from a real `--parts` run into a local database (the runbook step) and its `bytesPerPart` stat. See Plan notes 2.

- [ ] **Step 1: Write failing tests**
  - Extend `fakeWikidata` with an optional `sparql(query: string): Record<string, string>[] | Response` answer.
  - `imports a show's seasons and episodes`:
    - the show is imported first by a normal run;
    - `--parts` adds 2 seasons and 3 episodes, each with `parent` and `position` as Wikidata gives them;
    - `partsAdded: 5`;
    - one submission per season, counted from `submissions` rows with the run id.
  - `P155 adds no sequel links`: no `work_link` relation exists after the run.
  - `P179 adds no series membership`: no `series_work`, and no `series` entity was created.
  - `credits only creators AMDB holds`:
    - the episode's director is a live creator, so it is credited;
    - its writer isn't in AMDB, so `creditsSkipped: 1` and no creator row is added.
  - `episode-only creator never created`: the creator count is unchanged.
  - `low max-db-bytes stops between seasons`:
    - `measureBytes` returns over the cap after the first submission;
    - the status is `capped`;
    - season 1 and its episodes exist;
    - no episode exists without a parent, and no season 2 exists.
  - `item held as a series is skipped`: a QID already in AMDB as a root `series`, which Wikidata calls a season, gives `partsHeldAsRoot: 1`, and its subtype is unchanged.
  - `re-run adds only what's new`:
    - a second run with one more episode gives `partsAdded: 1` and `partsPresent: 5`;
    - a third run gives `partsAdded: 0`.
  - `reverted episode stays reverted`: a moderator reverts an episode's link and then its create. Re-running gives `partsSkipped.reverted: 1` and no new create.
  - `hand-entered season is adopted`:
    - a person entered "Season 1" under the show at position 1, with no wikidata id;
    - the run gives it the wikidata id, `partsAdopted: 1`, and its title is unchanged;
    - the episodes land under it.
  - `revert of the show's import fails until its parts are reverted`: reverting the show's create is 409 `has_dependents`.
  - `per-class counts`: an anime-episode subclass item is counted under its class QID in `partsByClass`.
  - `batch query failure is split per show`: multi-show SPARQL answers 504 and single-show queries succeed, so the run finishes.
  - In `import-cli.test.ts`:
    - `--parts --backfill` throws, naming `--backfill`;
    - `--parts --classes Q11424` throws.
- [ ] **Step 2:** `pnpm --filter @amdb/api test wikidata-parts import-cli`. Expected: FAIL.
- [ ] **Step 3:** Implement, then update both docs. `docs/import.md` §7 covers:
  - the command, run detached as in §6: `nohup pnpm import:wikidata --parts --limit N`;
  - the dry run;
  - a local `--parts --limit 20` rehearsal for `bytesPerPart`;
  - the projection: current size plus about 211,000 × `bytesPerPart`, which must stay under the 3.5 GB cap. If it doesn't, apply §5 first;
  - every stat above;
  - the owner's go-ahead, and never during a deploy.
- [ ] **Step 4:** `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(api): import wikidata seasons and episodes with --parts`, then `docs: describe the parts import`.

---

## Controller rulings on the drafter's notes

1. **Rejecting a pending show leaves its pending part creates pending, without a parent.** That's allowed, and a moderator reviews them on their own; no new cascade rule. The spec's line is corrected to match the code. Task 2's test pins this. *Cost if wrong:* a moderator rejecting a bad show also rejects its parts by hand.
2. **The dry run is split.** `--parts --dry-run` reports counts only: per class, placement and skipped credits. `bytesPerPart` comes from a real `--parts` run into a local database before any production run. *Cost if wrong:* the size figure comes from a local sample, not from production.
3. **A part is defined by subtype** (`season`, `episode`) for this release. The games spec revisits it before any `expansion` or `dlc` subtype exists, because a standalone expansion must stay a root. *Cost if wrong:* none for TV.
4. **Season 0 lists after unnumbered seasons.** *Cost if wrong:* a display order change.
5. **Adoption matches hand-entered seasons by subtype and position under the same show, falling back to the title.** *Cost if wrong:* a hand-entered season with a wrong number is duplicated, not adopted, and someone merges it.
6. **Unmerges restore the tree in reverse order.** Undoing an earlier merge first gives `409 stale_change`. Task 3 tests both orders. *Cost if wrong:* a moderator undoes the merges in the opposite order.
