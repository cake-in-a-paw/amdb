# Creator Credits by Show Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A creator's page lists one row per show or film, with every role under it, and links to a paged view of their credits within one show.

**Architecture:**
- The creator entity view swaps `relations.works` for `relations.credits`: one entry per root work, grouped in SQL by a recursive climb of live `work_part` links, so a studio's page never loads its episode credits.
- A new endpoint pages one creator's credits at or under one work, in depth-first parts order.
- The web's list page gets a creator branch, plus a focused page under `/entities/$id/credits/$workId`.

**Tech Stack:** Hono + `@hono/zod-openapi` (zod 4), Drizzle on Postgres (PGlite in tests), React + TanStack Router/Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-creator-credits-by-show-design.md`

## Global Constraints

- **Constitution `CLAUDE.md` 0.2.0 binds every task.**
  - VI: tests drive HTTP against PGlite with the real migrations.
  - VIII: `repository.ts` holds Drizzle queries only, and `service.ts` holds the rules.
  - IX: every cast or `!` outside tests carries a why-comment.
  - XI: one error shape, and the web renders loading, error and empty states.
  - XIII: delete what you replace, and keep docs true.
- **What counts as a credit:** a live `work_creator` relation (`removed_by_change IS NULL`) to a *listed* work (the `listed()` rule). This is the same set a creator page shows today.
- **Root:** the top of a credited work's live `work_part` chain. A work with no live parent link is its own root, and that includes orphan parts. The climb is capped at the existing `MAX_DEPTH` of 8.
- **Roles:**
  - each role appears once per row;
  - they follow the order of `[...CreatorRole.film_tv.options, ...CreatorRole.book.options]`, and any other string comes after, alphabetically.
- **Row order:** by each row's earliest credit, `(relations.created_at, relations.id)`, matching today's order.
- **API shapes:** exact names below; field names and copy are fixed by the spec.
- **OpenAPI snapshot:**
  - regenerate it, never hand-edit it, with `pnpm --silent --filter @amdb/api openapi:dump > apps/api/test/fixtures/openapi.snapshot.json` and then `pnpm --filter @amdb/shared gen:api`;
  - keep `--silent`, because the pnpm banner corrupts the JSON.
- **Copy:**
  - part counts read `"1 season"`, `"2 seasons"`, `"1 episode"` and `"14 episodes"`, joined `", "`, seasons first;
  - roles read `roleLabel` joined `", "`;
  - the focused page's heading reads `In <title>`.
- **Commits:**
  - Conventional Commits with a lowercase subject of at most 100 characters, scopes `api|web|shared|db`;
  - signed with `git -c gpg.format=ssh -c gpg.ssh.program=ssh-keygen -c user.signingkey="$HOME/.ssh/id_claude_signing.pub" commit -S`, with the session trailers;
  - stage named paths only;
  - `pnpm check` before each task's last commit.

## Review Focus

1. **A credit on the show and on its episodes:** one row, not two, with the roles merged. Task 1, `a creator's credits group parts under their show`.
2. **Several credits made in one submission share a `created_at`:** row order falls back to the relation id and stays deterministic between calls. Task 1, `credits order is stable across calls`.
3. **A show is taken down while its episodes stay listed:** the row stays, marked removed, and the focused view still lists the episodes. Tasks 1 and 2, the `removed show` tests.
4. **Paging the focused view:** pages of 1 rejoin into exactly the unpaged order, with no repeats. Task 2, `paging returns each credit once, in order`.
5. **A merged creator id on the focused endpoint:** a 308 to the winner, with `workId` kept. Task 2, `a merged creator redirects`.

---

### Task 1: `relations.credits` on the creator view

**Files:**
- Modify: `apps/api/src/features/catalog/repository.ts`:
  - `activeRelations` gains an `except` option;
  - add `creditRoots`.
- Modify: `apps/api/src/features/catalog/service.ts`, the `case 'creator':` branch of `getEntity`, and a `byRoleOrder` helper.
- Modify: `apps/api/src/features/catalog/schemas.ts`:
  - add `credits` to `EntitySchema.relations`;
  - the `works` doc becomes "The works of a series, property or tag."
- Regenerate: `apps/api/test/fixtures/openapi.snapshot.json`, `packages/shared/src/api/schema.ts`
- Test: `apps/api/test/creator-credits.test.ts` (new). Fix any existing API test that reads a creator's `relations.works`.

**Interfaces:**
- **Produces:**
  - `activeRelations(id: string, opts?: { except?: RelationType[] })`. `work_part` stays excluded always. The creator branch passes `{ except: ['work_creator'] }`.
  - `creditRoots(creatorId: string, maxDepth: number): Promise<{ rootId: string; rootListed: boolean; roles: string[]; parts: { subtype: Subtype; n: number }[] }[]>`:
    - one row per root, already in row order;
    - `parts` counts the credited works under the root, other than the root itself, by subtype;
    - one SQL statement: a recursive CTE climbing `work_part` from the credited works.
  - `relations.credits: { work: Summary; removed: boolean; roles: string[]; parts: Partial<Record<Subtype, number>> }[]`:
    - schema `z.partialRecord(Subtype, z.number().int())`, in `PART_SUBTYPES` order;
    - `removed` is true when the root isn't listed. Its `work` is then built from `workRows`, using its stored title, media type and year.
  - Creators no longer carry `relations.works`.

- [ ] **Step 1: Write the failing tests** in `creator-credits.test.ts`. Use the `setup()` and `publish` style of `parts-read.test.ts`, and `removeEntity` as in `work-parts.test.ts`.
  - **Fixture:** creator `C`; film `F`; show `S` (series) with `S1` (pos 1) and `S2` (pos 2); `E11` (pos 1) and `E12` (pos 2) under `S1`; `E21` (pos 1) under `S2`; `X` (pos 5) directly under `S`; and orphan episode `O`, which has no parent.
  - **Credits:** `F` director, `S` producer, `E11` writer, `E12` director, `E21` director, `S2` director, `X` director, `O` writer, `F` writer.
  - **`a creator's credits group parts under their show`:** sorted by title, `relations.credits` equals:
    - `{ work: {id: F…}, removed: false, roles: ['director', 'writer'], parts: {} }`;
    - `{ work: {id: O…}, removed: false, roles: ['writer'], parts: {} }`;
    - `{ work: {id: S…}, removed: false, roles: ['director', 'writer', 'producer'], parts: { season: 1, episode: 4 } }`.
    - Match `work` with `expect.objectContaining({ id })`.
  - **`credits keep the order of each row's earliest credit`:**
    - publish `E11` writer, then `F` director, then `S` producer, in three separate submissions;
    - the order of `credits` ids is `[S, F]`.
  - **`credits order is stable across calls`:** two GETs of the fixture creator return identical `credits`.
  - **`a removed show keeps its row, marked removed`:**
    - an admin removes `S`;
    - its row has `removed: true`, `work.title: 'S'`, `parts: { season: 1, episode: 4 }`, and roles `['director', 'writer']`, without `producer`, because the credit on `S` is no longer to a listed work.
  - **`a removed film drops out, as today`:** an admin removes `F`, and no row has its id.
  - **`only creators trade works for credits`:** a creator has `relations.works` undefined, and a series still has `relations.works`.
- [ ] **Step 2: Run** `pnpm --filter @amdb/api test creator-credits`. Expected: FAIL, because `credits` is undefined.
- [ ] **Step 3: Implement** the produced interfaces.
  - `byRoleOrder(roles: string[]): string[]` lives in service.ts.
  - Keep `MAX_DEPTH` in service.ts and pass it in.
  - Regenerate the snapshot and the client types.
- [ ] **Step 4: Run** `pnpm --filter @amdb/api test`. Expected: PASS, including `openapi.test.ts`.
- [ ] **Step 5:** `pnpm check`, then commit `feat(api): group a creator's credits under their show`.

### Task 2: Paged credits under one work

**Files:**
- Modify: `apps/api/src/features/catalog/repository.ts`, adding `subtree` and `creditsAmong`.
- Modify: `apps/api/src/features/catalog/service.ts`, adding `creditsUnder`.
- Modify: `apps/api/src/features/catalog/schemas.ts`, adding `CreditsCursor` and `CreditsUnderSchema`.
- Modify: `apps/api/src/features/catalog/routes.ts`, adding `creditsUnderRoute`.
- Regenerate: the snapshot and the client types.
- Test: `apps/api/test/creator-credits-under.test.ts` (new).

**Interfaces:**
- **Consumes:** Task 1's fixture shape; `ancestry(workIds)`, `resolveLive`, `resolveWinner` and `toSummary` in the service; and `encodeKeyCursor`/`decodeKeyCursor`.
- **Produces:**
  - **Route:** `GET /api/entities/{id}/credits/{workId}`, with query `PageQuery` (`cursor`, `limit` 1–50, default 20).
    - `id` behaves like the parts route: 404, 410, or a 308 to `/api/entities/{winner}/credits/{workId}`.
    - A non-creator `id` gets `{ under, items: [], nextCursor: null }`.
    - `workId`: unknown, or not a work, gives `404 not_found`; merged follows `resolveWinner`. Any other state is allowed, removed included.
  - **Response:** `CreditsUnderSchema = { under: { work: Summary; removed: boolean }; items: { work: Summary; roles: string[] }[]; nextCursor: string | null }`.
    - For a credited work below `workId`, `item.work.part = { subtype, position?, ancestors }`, built from `ancestry`, root first.
    - `workId`'s own credit, if any, has no `part`.
  - `subtree(workId: string, maxDepth: number): Promise<{ id: string; parentId: string; position: number | null; subtype: Subtype | null; title: string; releaseYear: number | null; releaseMonth: number | null; releaseDay: number | null }[]>`: every listed work below `workId`, through live `work_part` links.
  - `creditsAmong(creatorId: string, workIds: string[]): Promise<{ workId: string; role: string }[]>`: live credits to the listed works among those ids.
  - `CreditsCursor = z.object({ o: z.number().int().min(0) })`. It is an offset into the ordered list; see the spec's Production Annotations.
- **Order (service):**
  - `workId` first, then depth-first.
  - At each level, sort siblings by `(subtype === 'season' ? 0 : 1, b, p, y, m, d, title, id)`, where `b`, `p`, `y`, `m` and `d` are computed exactly as in `repository.parts`.
  - A parent comes directly before its descendants.
  - Only works the creator is credited on become items; an uncredited season has no row, but its credited episodes are listed in its place.

- [ ] **Step 1: Write the failing tests** with Task 1's fixture.
  - **`a show's credits list depth-first, seasons first`:** `GET /api/entities/C/credits/S` gives:
    - item ids `[S, E11, E12, S2, E21, X]`;
    - roles `[['producer'], ['writer'], ['director'], ['director'], ['director'], ['director']]`.
    - `items[1].work.part` equals `{ subtype: 'episode', position: 1, ancestors: [{ id: S, title: 'S', subtype: 'series', removed: false }, { id: S1, title: 'S1', subtype: 'season', position: 1, removed: false }] }`.
    - `under` equals `{ work: objectContaining({ id: S }), removed: false }`.
  - **`paging returns each credit once, in order`:** following `nextCursor` with `?limit=1` yields the same ids as the unpaged call, and the last page has `nextCursor: null`.
  - **`a removed show's episodes stay reachable`:** an admin removes `S`. Then:
    - `under.removed` is `true`;
    - the items are `[E11, E12, S2, E21, X]`, without `S`, which is no longer a listed credit.
  - **`a merged creator redirects`:** after a merge of `C` into `C2`, the GET answers 308 with `Location: /api/entities/${C2}/credits/${S}`.
  - **`unknown work is 404`:** a random UUID as `workId` gives 404 `not_found`.
  - **`a non-creator has no credits`:** `GET /api/entities/F/credits/S` gives 200 with `items: []`.
  - **`a bad cursor is 400`:** `?cursor=nope` gives 400 `invalid_cursor`.
- [ ] **Step 2: Run** `pnpm --filter @amdb/api test creator-credits-under`. Expected: FAIL with 404, because there is no route yet.
- [ ] **Step 3: Implement** the route, service, repository and schemas above. Regenerate the snapshot and the client types.
- [ ] **Step 4: Run** `pnpm --filter @amdb/api test`. Expected: PASS.
- [ ] **Step 5:** `pnpm check`, then commit `feat(api): page a creator's credits under one work`.

### Task 3: Creator page rows

**Files:**
- Modify: `apps/web/src/lib/parts.ts`, adding `creditPartsLabel`.
- Modify: `apps/web/src/lib/labels.ts`, adding `rolesLabel`.
- Create: `apps/web/src/components/credit-row.tsx`
- Modify: `apps/web/src/components/list-page.tsx`, adding the creator branch.
- Test: `apps/web/test/parts.test.ts`, `apps/web/test/list-pages.test.tsx`

**Interfaces:**
- **Consumes:** Task 1's `relations.credits`, and Task 2's route path for the link target.
- **Produces:**
  - `creditPartsLabel(parts: Partial<Record<Subtype, number>>): string`. Subtypes come in `PART_SUBTYPES` order, with nouns `season/seasons` and `episode/episodes`; `''` when empty.
  - `rolesLabel(roles: string[]): string`, which is `roles.map(roleLabel).join(', ')`.
  - `CreditRow({ creatorId, credit }: { creatorId: string; credit: Credit })`, an `<li>`:
    - a link to the work, styled like `EntryRow`. For a removed root, the text "a removed work" (the existing copy) and no link;
    - the detail is `[rolesLabel(roles), summaryDetail(work)]` joined `' · '`;
    - when `creditPartsLabel` isn't empty, a second link with that text to `/entities/$id/credits/$workId`, with `aria-label` `` `${label} in ${title}` ``.
  - `Credit` is the generated client type of one `credits` entry.

- [ ] **Step 1: Write the failing tests.**
  - `parts.test.ts`, `creditPartsLabel`:
    - `{ season: 2, episode: 14 }` gives `'2 seasons, 14 episodes'`;
    - `{ episode: 1 }` gives `'1 episode'`;
    - `{}` gives `''`.
  - `list-pages.test.tsx`, `a creator page lists a show once, with every role under it`:
    - publish, through the harness's `publish`, a show `Show` with season `S1` (pos 1) and episodes `Pilot` (pos 1) and `Two` (pos 2), with the creator credited as writer on `Pilot` and director on `Two`;
    - the "Works" list then has exactly one item containing `Show`, which contains `Director, Writer`;
    - a link named `2 episodes in Show` has an href of `/entities/${creator}/credits/${show}`.
  - The existing `a creator page lists their works with the role they had` still passes unchanged: 3 items, the first containing `Director`.
- [ ] **Step 2: Run** `pnpm --filter @amdb/web test parts list-pages`. Expected: FAIL.
- [ ] **Step 3: Implement** the produced interfaces. The creator branch of `ListPage` renders a "Works" section of `CreditRow`s, empty text "No works yet.". Series, property and tag pages are unchanged.
- [ ] **Step 4: Run** `pnpm --filter @amdb/web test`. Expected: PASS.
- [ ] **Step 5:** `pnpm check`, then commit `feat(web): list a creator's shows once with their roles`.

### Task 4: The focused credits page

**Files:**
- Create: `apps/web/src/routes/entities.$id.credits.$workId.tsx`
- Create: `apps/web/src/components/creator-credits.tsx`
- Test: `apps/web/test/creator-credits.test.tsx` (new)

**Interfaces:**
- **Consumes:**
  - Task 2's endpoint and response;
  - `partLabel`, `rolesLabel`, `EntryRow`, `LoadMore`, `Loading`, `LoadError`;
  - the `PartsList` pattern (`useInfiniteQuery`, page size 50).
- **Produces:** `CreatorCredits({ creatorId, workId })`, rendered under the `/entities/$id` layout:
  - Its `h2` heading is `In <under title>`. It links to the work, or reads "a removed work" when `under.removed`.
  - Its list is labeled by the heading, with one `EntryRow` per item:
    - the title is `[partLabel(subtype, position, ancestors), season ? '' : title]` joined `' · '` for a part, or the work's title for a non-part;
    - the detail is `rolesLabel(roles)`.
  - Query key `['credits', creatorId, workId]`.
  - States:
    - loading: `<Loading what="credits" />`;
    - error: `<LoadError what="credits" …/>`;
    - no items: "No credits here.".

- [ ] **Step 1: Write the failing tests** in `creator-credits.test.tsx`, using Task 3's published show, plus a director credit on the show itself.
  - **`a creator's credits in one show list depth-first`:**
    - navigate to `/entities/$id/credits/$workId`;
    - the heading is `In Show`;
    - the list items' text, in order, contains `Show`, `S1E1 · Pilot` with `Writer`, and `S1E2 · Two` with `Director`.
  - **`the episode count opens the focused page`:**
    - on the creator page, clicking `2 episodes in Show` shows the heading `In Show`.
- [ ] **Step 2: Run** `pnpm --filter @amdb/web test creator-credits`. Expected: FAIL, because there is no route.
- [ ] **Step 3: Implement** the route file and the component. The router's generated route tree updates through the existing TanStack plugin.
- [ ] **Step 4: Run** `pnpm --filter @amdb/web test`. Expected: PASS.
- [ ] **Step 5:** `pnpm check`, then commit `feat(web): show a creator's credits in one show`.
