# AMDB Foundation and Contribution Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working AMDB API where anyone can submit works, creators, series, properties, tags
and the links between them, moderators approve or reject each change, and approved data is
readable with full public history, merges and redactions.

**Architecture:** A pnpm monorepo cloned in shape from `~/dev/rmd` (Hono + zod-openapi, Drizzle
on Postgres/PGlite, Better Auth). Current state lives in per-kind tables keyed by a shared
`entities` registry, with all relationships in one `relations` table. Every write is a row in
`changes`. A change is approved (applied to current state in one transaction, recording its
inverse) or rejected. One `ReviewPolicy` function decides whether a new change is held or
published immediately.

**Tech Stack:** TypeScript (strict), pnpm 10, Node 22+, Hono 4, @hono/zod-openapi, zod 4,
Drizzle ORM + drizzle-kit, PGlite (tests, local), node-postgres, Better Auth, Vitest, Prettier,
oxlint, husky, lint-staged, commitlint. Pin the exact versions in `~/dev/rmd/package.json` and
`~/dev/rmd/apps/api/package.json`.

**Spec:** `docs/superpowers/specs/2026-11-02-amdb-design.md`

**Plan series.** The spec is split into five plans, each producing working software:

1. **This plan:** repo, constitution, data model, submissions, moderation, history, merge,
   redaction, anonymous claim (API only).
2. Web app: browser, submission and editing UI with drafts and the duplicate check,
   moderation UI, Railway deploy.
3. Importers: Wikidata (film, TV, anime) and Open Library (books), English only, batched.
4. API access: key requests and grants, metering, the free monthly allowance, the credit
   ledger and points table.
5. Monthly CC0 dumps.

## Global Constraints

- Everything is CC0. Every submission carries `cc0: true`; a submission without it is a 400.
- Every write to catalog tables happens inside `applyChange` (Task 5). Nothing else writes
  `works`, `creators`, `series`, `properties`, `tags`, `relations` or `entities`. The
  architecture test enforces this.
- History is append-only, except redaction (Task 8), which erases a change's `payload` and
  `inverse` and keeps the row.
- Contributors' work is never hard-deleted. Rejection keeps the change and its payload.
- A caller who can't see a resource gets 404, not 403 (constitution, privacy principle).
- One error shape: `{ "error": { "code", "message", "details"? } }`.
- Value lists are `text` columns validated by zod in `@amdb/shared`, never Postgres enums.
- American English everywhere, including `catalog`.
- Exact dependency versions, matching rmd's where rmd already uses the package.
- Signed commits with the Claude key (see the user's global CLAUDE.md), Conventional Commits,
  scopes `api`, `shared`, `db`, `adr`, `ci`, `docs`.

## Review Focus

1. **A relation whose endpoint is still pending or was rejected.** Approving it must answer
   409 `dependency_pending`. Rejecting a create change must reject its pending dependents with
   reason `Depends on rejected change <id>`. Both stay resubmittable. (Task 5)
2. **Two edits to the same field.** An update change records the values it expected
   (`base`). Approving it after the field changed answers 409 `stale_change` instead of
   silently overwriting. (Task 5)
3. **A pending change that targets an entity that was later merged.** At approval it applies
   to the merge winner. (Task 7)
4. **Anonymous submit without an anonymous token.** The answer is 400 `identity_required`, so
   no anonymous work is created that its author could never see or claim. (Task 4)
5. **Titles differing only in case, spacing or accents** ("  Amélie " vs "amelie") are found by
   search and by the duplicate check. (Task 6)

---

## File Structure

```
CLAUDE.md, AGENTS.md, README.md          constitution, agent pointer, setup
docs/decisions/000{0,1,2,3}-*.md          ADR template, ADRs 0001–0003
package.json, pnpm-workspace.yaml, tsconfig.base.json, .prettierrc.json, .oxlintrc.json,
.prettierignore, .gitignore, .node-version, commitlint.config.mjs, .husky/*, .github/workflows/ci.yml
packages/shared/src/values.ts             value lists
packages/shared/src/fields.ts             per-kind field schemas (shared with the web app)
packages/shared/src/index.ts
apps/api/src/app.ts, server.ts, env.ts
apps/api/src/platform/db/{open,schema,types}.ts
apps/api/src/platform/http/{errors,openapi,app-env,rate-limit}.ts
apps/api/src/platform/auth/auth.ts
apps/api/src/features/users/        routes, service, repository, schemas, middleware.ts, identity.ts
apps/api/src/features/changes/      routes, service, repository, schemas, apply.ts, review-policy.ts
apps/api/src/features/catalog/      routes, service, repository, schemas, normalize.ts
apps/api/drizzle/                   migrations
apps/api/test/helpers/setup.ts      setupTest(), actors
apps/api/test/*.test.ts
```

`changes` owns every catalog write (through `apply.ts`). `catalog` only reads.

---

### Task 1: Constitution and ADRs

**Files:**
- Create: `CLAUDE.md`, `AGENTS.md`, `docs/decisions/0000-template.md`,
  `docs/decisions/0001-record-decisions-as-adrs.md`, `docs/decisions/0002-stack-and-tooling.md`,
  `docs/decisions/0003-constitution.md`

- [ ] **Step 1: Write `CLAUDE.md`** in the form of `~/dev/rmd/CLAUDE.md`, with the principles
  listed in spec §10, in this order:
  1. Privacy rules are tested from the outside.
  2. Everything is CC0.
  3. Every change is a recorded revision.
  4. Contributors' work is never discarded.
  5. One dataset, three views.
  6. Tests run against real Postgres.
  7. Simple by default, uniform by rule.
  8. Feature folders, three layers.
  9. Types and schemas are the contract.
  10. The database guards its invariants.
  11. One error shape.
  12. Dependencies are decisions.
  13. No dead architecture.

  Adapt rmd's text where it names rmd-specific things (`@rmd/shared` → `@amdb/shared`, no
  catalog sources folder, no `catalogue` spelling exception). Principle 3 includes the
  redaction exception from spec §10. Keep Standards and Governance from rmd, but drop the
  Linear IDs. Use rmd's ADR 0006 relaxation (land on `main` when `pnpm check` passes), stated
  inline. Version `0.1.0 (proposed)`.
- [ ] **Step 2: Write `AGENTS.md`**, a one-paragraph pointer to `CLAUDE.md`, as in rmd.
- [ ] **Step 3: Write the ADRs.**
  - 0000: copy rmd's template.
  - 0001: record decisions as ADRs.
  - 0002: stack and tooling. Same as rmd's 0002, minus AniList and rmd's Railway budget line.
    Record "same stack as rmd" and the reason (owner's familiarity, shared patterns).
  - 0003: the constitution, with what was carried over and what replaced rmd's principles I
    and II.
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md docs/decisions
git commit -m "docs(adr): adopt the AMDB constitution"
```

---

### Task 2: Monorepo scaffold

**Files:**
- Create: root tooling files listed in File Structure, copied from `~/dev/rmd` and renamed
  `rmd` → `amdb`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}` (`@amdb/shared`)
- Create: `apps/api/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}`
  (`@amdb/api`)
- Create: `apps/api/src/{app.ts,server.ts,env.ts}`
- Create: `apps/api/src/platform/db/{open.ts,types.ts,schema.ts}`,
  `apps/api/src/platform/http/{errors.ts,openapi.ts,app-env.ts}`
- Create: `apps/api/drizzle/0000_extensions.sql` (citext, as in rmd)
- Create: `apps/api/test/{health.test.ts,architecture.test.ts,openapi.test.ts}`,
  `apps/api/test/helpers/setup.ts`, `apps/api/scripts/dump-openapi.ts`
- Create: `README.md` (setup, run, checks; modeled on rmd's README)

**Interfaces:**
- Produces:
  - `createApp(deps: AppDeps)`, where `AppDeps = { db: Db; getSession: (h: Headers) => Promise<SessionInfo | null>; authHandler?; webOrigin?; reviewPolicy?: ReviewPolicy }`. `reviewPolicy` is added in Task 5.
  - `openDb(url): Promise<OpenedDb>`.
  - `Db`, `Tx`, `DbOrTx`.
  - `ApiError`, `notFound`, `badRequest`, `conflict`, `errorBody`, `handleError`.
  - `setupTest(opts?) => { app, db, close, as(actor) }`. `as(actor)` returns
    `{ get(path), post(path, body) }` that set `x-test-user` for a user actor and
    `x-amdb-anon` for an anonymous actor.

Copy rmd's `platform/db/open.ts`, `platform/http/errors.ts` and `platform/http/openapi.ts`
nearly verbatim. Drop sync and images.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/test/health.test.ts
it('answers GET /api/health with ok', async () => {
  const t = await setupTest();
  const res = await t.app.request('/api/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
it('answers unknown /api paths with the error shape', async () => {
  const t = await setupTest();
  const res = await t.app.request('/api/nope');
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
});
```

- [ ] **Step 2: Run** `pnpm install && pnpm --filter @amdb/api test`. Expected: FAIL (no app).
- [ ] **Step 3: Implement** the scaffold. `/api/health` is a zod-openapi route in `app.ts`.
  Copy rmd's `architecture.test.ts` (its layering rules), and add one rule: only
  `features/changes/apply.ts` and the `changes` repository may import the catalog table
  objects (`works`, `creators`, `series`, `properties`, `tags`, `relations`, `entities`) from
  `platform/db/schema`, other than `catalog/repository.ts`, which only reads. Copy rmd's
  `openapi.test.ts` and `scripts/dump-openapi.ts`.
- [ ] **Step 4: Run** `pnpm openapi:dump` to write the snapshot, then `pnpm check`.
  Expected: all green.
- [ ] **Step 5: Commit** — `chore: scaffold the AMDB monorepo`

---

### Task 3: Value lists and catalog schema

**Files:**
- Create: `packages/shared/src/values.ts`, `packages/shared/src/fields.ts`
- Modify: `apps/api/src/platform/db/schema.ts`
- Create: migration via `pnpm --filter @amdb/api db:generate`, plus `--custom` for CHECKs and
  the generated `search` column
- Test: `apps/api/test/schema.test.ts`

**Interfaces:**
- Produces (`@amdb/shared`):

```ts
export const EntityKind = z.enum(['work', 'creator', 'series', 'property', 'tag']);
export const MediaType = z.enum(['film_tv', 'book']);
export const Subtype = z.enum(['movie', 'series', 'anime_series', 'anime_film']); // film_tv only; null for book
export const Lifecycle = z.enum(['released', 'upcoming', 'airing', 'unknown']);
export const CreatorKind = z.enum(['person', 'organization']);
export const CreatorRole = {
  film_tv: z.enum(['director', 'writer', 'creator', 'producer', 'studio', 'composer']),
  book: z.enum(['author', 'illustrator', 'translator', 'editor']),
};
export const RelationType = z.enum(['work_creator', 'series_work', 'property_work', 'work_link', 'work_tag', 'external_id']);
export const WorkLinkType = z.enum(['adapted_from', 'sequel_of', 'remake_of', 'spin_off_of']);
export const TagKind = z.enum(['genre', 'theme', 'content_warning']);
export const IdScheme = z.enum(['wikidata', 'openlibrary', 'isbn13', 'imdb']);
export const ChangeOp = z.enum(['create', 'update', 'relate', 'unrelate', 'merge']);
export const ChangeStatus = z.enum(['pending', 'published', 'approved', 'rejected']);
export const Role = z.enum(['contributor', 'moderator', 'admin']);
```

  `fields.ts` exports `WorkFields`, `CreatorFields`, `SeriesFields`, `PropertyFields` and
  `TagFields` (zod objects; the `create` shape) and `FieldsFor[kind]`. The update shape is
  `.partial()`.
  - `WorkFields = { mediaType, subtype: nullable, title (1–500, trimmed), originalTitle?, description? (≤ 5000), releaseYear? (1–9999), releaseMonth? (1–12), releaseDay? (1–31), lifecycle (default 'unknown'), attributes? }`. Attributes for film_tv are `{ runtimeMin?, episodes?, originalLanguage? }`; for book, `{ pageCount?, originalLanguage? }`. Refinements: subtype is required iff mediaType is film_tv; month only with year; day only with month and valid for that month.
  - `CreatorFields = { name, kind, description? }`.
  - `SeriesFields` and `PropertyFields` = `{ title, description? }`.
  - `TagFields = { kind, name, slug (/^[a-z0-9-]+$/) }`.
- Produces (DB tables; column names snake_case):
  - `entities(id uuid pk, kind, merged_into_id → entities null, removed_at null, field_sources jsonb default '{}', created_at, updated_at)`. `field_sources` maps a field name to the change id that last set it.
  - `works(entity_id pk → entities, media_type, subtype, title, title_norm, original_title, description, release_year, release_month, release_day, lifecycle, attributes jsonb, search tsvector generated from title_norm + original_title)`.
  - `creators(entity_id, name, name_norm, kind, description)`.
  - `series(entity_id, title, title_norm, description)`.
  - `properties(entity_id, title, title_norm, description)`.
  - `tags(entity_id, kind, name, slug unique)`.
  - `relations(id uuid pk, type, from_id → entities, to_id → entities null, role, position int, link_type, scheme, value, created_by_change → changes, removed_by_change → changes null, created_at)`.
  - `submissions(id, author_user_id → users null, anon_hash text null, note, created_at)`, with CHECK exactly one of author_user_id or anon_hash.
  - `changes(id, submission_id, seq int, op, kind, entity_id → entities null, relation_id → relations null, payload jsonb, base jsonb null, inverse jsonb null, status, reason, depends_on uuid[] default '{}', resubmit_of → changes null, reviewed_by → users null, reviewed_at, applied_at, redacted_at, redaction_reason, created_at)`.
  - Indexes: `changes(status, created_at)`, `relations(from_id) where removed_by_change is null`, `relations(to_id) where removed_by_change is null`, unique `relations(scheme, value) where type = 'external_id' and removed_by_change is null`, GIN on `works.search`.
  - CHECKs (custom migration):
    - relation-type column rules: `work_creator` needs role; `series_work` needs position; `work_link` needs link_type; `external_id` needs scheme and value and a null to_id; the others need to_id.
    - works date parts, as in rmd.
    - subtype iff `media_type = 'film_tv'`.
  - `users` comes from Better Auth in Task 4, so declare `submissions.author_user_id` and `changes.reviewed_by` in that task's migration if ordering requires it.

- [ ] **Step 1: Write the failing tests** in `schema.test.ts`:
  - `rejects a work_link relation without link_type` (raw insert throws a check violation).
  - `rejects a book with a subtype`.
  - `rejects release_day without release_month`.
  - `rejects two active external_id rows with the same scheme and value, but allows one after the first is removed`.
- [ ] **Step 2: Run** `pnpm --filter @amdb/api test schema`. Expected: FAIL.
- [ ] **Step 3: Implement** the schema, generate migrations, and write the custom migration
  with the CHECKs.
- [ ] **Step 4: Run** the tests and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(db): add the catalog and change tables`

---

### Task 4: Accounts, roles and anonymous identity; submissions

**Files:**
- Create: `apps/api/src/platform/auth/auth.ts` (from rmd: email OTP, Google, GitHub, passkeys; drop rmd's username, sign-up limit and allowlist hooks)
- Create: `apps/api/src/features/users/{routes,service,repository,schemas,middleware}.ts`, `identity.ts`
- Create: `apps/api/src/features/changes/{routes,service,repository,schemas}.ts`
- Create: `apps/api/src/platform/http/rate-limit.ts`
- Modify: `apps/api/src/env.ts` (`ADMIN_EMAILS`, comma-separated), `app.ts`
- Test: `apps/api/test/{roles,submissions}.test.ts`

**Interfaces:**
- Produces:
  - `users.role text default 'contributor'`. A user whose email is in `ADMIN_EMAILS` is created as `admin`.
  - Middleware `resolveActor` sets `c.var.actor: Actor`, where `type Actor = { kind: 'user'; userId: string; role: Role } | { kind: 'anon'; anonHash: string } | { kind: 'none' }`. The anonymous token comes from the `x-amdb-anon` header: 32–128 URL-safe chars, stored as its SHA-256 hex. A session wins over the header.
  - `POST /api/admin/users/{id}/role` `{ role }`. Admin only, otherwise 404.
  - `POST /api/submissions` with body:

```ts
const EntityRef = z.union([z.object({ id: z.uuid() }), z.object({ ref: z.string().min(1).max(40) })]);
const ChangeInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), kind: EntityKind, ref: z.string().min(1).max(40), fields: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('update'), kind: EntityKind, entityId: z.uuid(), fields: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('relate'), type: RelationType, from: EntityRef, to: EntityRef.optional(),
             data: z.object({ role: z.string(), position: z.number().int().min(1), linkType: WorkLinkType, scheme: IdScheme, value: z.string() }).partial() }),
  z.object({ op: z.literal('unrelate'), relationId: z.uuid() }),
  z.object({ op: z.literal('merge'), kind: EntityKind, from: z.uuid(), into: z.uuid() }),
]);
const SubmissionInput = z.object({ cc0: z.literal(true), note: z.string().max(2000).optional(), changes: z.array(ChangeInput).min(1).max(200) });
```

  - The response is 201 `{ id, changes: [{ id, seq, op, status, entityId: string | null }] }`.
  - Server rules at submit time:
    - `fields` are validated with `FieldsFor[kind]` (create) or its `.partial()` (update).
    - Roles are validated against `CreatorRole[work.mediaType]`.
    - Each create is given a new entity id. The entity row isn't inserted until approval: `changes.entity_id` holds the reserved id, and the `entities` row is inserted by `applyChange`. So `changes.entity_id` is not a foreign key; the migration must reflect that.
    - Refs resolve within the submission; an unknown ref is 400 `unknown_ref`.
    - A change that references a pending create gets that create's change id in `depends_on`.
    - An update stores `base`: the current values of the fields it changes.
    - Ops referencing entities that don't exist (and aren't reserved by a visible pending create) are 400 `unknown_entity`.
  - `GET /api/submissions/{id}`: visible to its author (same user, or same anon hash) and moderators; otherwise 404. Returns each change's full payload, status and reason.
  - `GET /api/me/submissions`: the actor's submissions, newest first, paginated (`?cursor`), as in rmd's `platform/http/pagination.ts`.
  - `rateLimit({ key, limit, windowMs })`: an in-memory fixed-window limiter. Anonymous submissions are limited to 20 per hour per anon hash and per client IP (`x-forwarded-for`, first entry). Over the limit is 429 `rate_limited`.

- [ ] **Step 1: Write the failing tests**
  - `roles.test.ts`:
    - `an ADMIN_EMAILS user can make another user a moderator`.
    - `a contributor calling the role endpoint gets 404`.
  - `submissions.test.ts`:
    - `a signed-in user submits a new work with a creator and a work_creator link` asserts 201, three changes all `pending`, and the link's `depends_on` holding both creates' ids. The GET of the reserved work id returns 404 until approved.
    - `submission without cc0 is 400`.
    - `anonymous submission without x-amdb-anon is 400 identity_required`.
    - `an anonymous author sees their submission; another anon token and another user get 404; a moderator sees it` (privacy principle).
    - `a book with a director role is 400 invalid_role`.
    - `an unknown ref is 400 unknown_ref`.
    - `the 21st anonymous submission in an hour is 429`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the code above.
- [ ] **Step 4: Run** `pnpm --filter @amdb/api test` and `pnpm openapi:dump`, then
  `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): accept submissions from accounts and anonymous contributors`

---

### Task 5: Applying changes, review policy, moderation and reading entities

**Files:**
- Create: `apps/api/src/features/changes/apply.ts`, `apps/api/src/features/catalog/normalize.ts`
- Create: `apps/api/src/features/changes/review-policy.ts`
- Modify: `apps/api/src/features/changes/{routes,service,repository,schemas}.ts`
- Create: `apps/api/src/features/catalog/{routes,service,repository,schemas}.ts`
- Modify: `apps/api/src/app.ts` (`reviewPolicy` dep, default `holdAll`)
- Test: `apps/api/test/{moderation,review-policy,entities}.test.ts`

**Interfaces (applying changes, `features/changes/apply.ts`, `features/catalog/normalize.ts`):**
- Produces:

```ts
/** Applies one change to current state in `tx`, returning its inverse. Throws ApiError on conflict. */
export async function applyChange(tx: Tx, change: ChangeRow): Promise<Inverse>;
export type Inverse =
  | { op: 'delete_entity'; entityId: string }                       // inverse of create
  | { op: 'set_fields'; entityId: string; fields: Record<string, unknown>; fieldSources: Record<string, string | null> } // inverse of update
  | { op: 'remove_relation'; relationId: string }                    // inverse of relate
  | { op: 'restore_relation'; relationId: string }                   // inverse of unrelate
  | { op: 'unmerge'; from: string; into: string; movedRelationIds: string[] };
export async function applyInverse(tx: Tx, inverse: Inverse, byChangeId: string): Promise<void>;
export const normalizeTitle = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
```

- Rules:
  - **Create** inserts the `entities` row (with the reserved id) and the kind row, writing `*_norm` columns.
  - **Update:** if any field's current value differs from `base`, throw 409 `stale_change` with `details: { fields }`.
  - **Relate:** if an endpoint entity doesn't exist yet, throw 409 `dependency_pending`.
  - **Unrelate** sets `removed_by_change`.
  - **Merge** is applied in Task 8; until then, throw 501 `not_implemented`.
  - Every op resolves `merged_into_id` chains to the winner before acting.
  - Every op sets `field_sources[field] = change.id` for each field it sets.
  - `delete_entity` (rejecting a published create) is the one hard delete of current state, and is allowed because nothing references the entity. If relations reference it, throw 409 `has_dependents`.

**Interfaces (review and reads):**
- Produces:

```ts
export type ReviewDecision = 'hold' | 'publish';
export interface ReviewContext { change: ChangeInput; actor: Actor }
export type ReviewPolicy = (ctx: ReviewContext) => ReviewDecision | Promise<ReviewDecision>;
export const holdAll: ReviewPolicy = () => 'hold';
```

- At submit time, the service asks the policy for each change.
  - `publish` applies the change right away, setting status `published` and `applied_at`.
  - It falls back to `hold` when the change has unmet `depends_on`.
- Endpoints:
  - `GET /api/moderation/queue?cursor` lists changes with status `pending` or `published`, oldest first. Each item is `{ change, submission: { id, author: 'anonymous' | { userId } }, ageSeconds }`. Moderators only; anyone else gets 404.
  - `POST /api/changes/{id}/approve` with an optional `{ fields }` body (edit-and-approve: the edit is merged into the payload, and the original is kept as `payload.submitted`).
    - From `pending`: applies the change and sets `approved`.
    - From `published`: sets `approved` only.
    - Records `reviewed_by` and `reviewed_at`.
  - `POST /api/changes/{id}/reject` `{ reason (1–1000) }`.
    - From `pending`: sets `rejected`.
    - From `published`: runs `applyInverse` and sets `rejected`.
    - Either way, every `pending` change whose `depends_on` includes it becomes `rejected` with reason `Depends on rejected change <id>`.
  - `POST /api/changes/{id}/resubmit` `{ fields?, data? }`. The rejected change's author only (otherwise 404). Creates a new change in a new submission, with `resubmit_of` set, and runs it through the policy. A resubmitted create keeps its reserved entity id.
  - `GET /api/entities/{id}` is public.
    - Returns `{ id, kind, fields, relations: { creators: [{ relationId, creator: Summary, role }], works: [...], series: [...], properties: [...], links: [{ relationId, type, direction: 'outgoing' | 'incoming', work: Summary }], tags: [...], externalIds: [{ scheme, value }] } }`, with the groups relevant to the kind.
    - `Summary = { id, kind, title, mediaType?, releaseYear? }`.
    - An unknown or never-approved id is 404.
- Approving or rejecting a change that is already approved or rejected is 409 `already_reviewed`.

- [ ] **Step 1: Write the failing tests**
  - `moderation.test.ts`:
    - `the queue lists pending changes oldest first with their age; a contributor gets 404`.
    - `approving the creates and the link makes GET /api/entities/:workId show the creator with role director`.
    - `approving a link before its creates is 409 dependency_pending` (Review Focus 1).
    - `rejecting a create rejects its pending link with the dependency reason; the author resubmits both and they can be approved` (Review Focus 1).
    - `approving an update whose field changed since submission is 409 stale_change` (Review Focus 2).
    - `edit-and-approve stores the moderator's value and keeps the submitted one`.
    - `the rejected change's author sees the reason in GET /api/submissions/:id`.
  - `review-policy.test.ts`, with an injected `reviewPolicy` that publishes updates and holds everything else:
    - `a published update is live immediately and in the queue`.
    - `rejecting it restores the previous value`.
    - `approving it changes only status`.
  - `entities.test.ts`:
    - `an outgoing adapted_from link appears as incoming on the novel`.
    - `external ids are listed`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `applyChange`, `applyInverse`, `normalizeTitle`, the policy and the endpoints above. Approve and reject run in one transaction each, with the change row locked (`select … for update`).
- [ ] **Step 4: Run** the tests, `pnpm openapi:dump` and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): moderate changes behind a swappable review policy`

---

### Task 6: History, provenance, revert, search and the duplicate check

**Files:**
- Modify: `features/changes/*`, `features/catalog/*`
- Test: `apps/api/test/{history,search}.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/entities/{id}/history?cursor` is public. It lists the approved and published changes that touched the entity or its relations, newest first. Each item is `{ changeId, op, payload, author: 'anonymous' | { userId }, source: 'human', appliedAt, revertOf: string | null }`. Pending and rejected changes never appear (privacy principle). Redacted changes appear as `{ changeId, op, redacted: true, reason }`.
  - `GET /api/entities/{id}` gains `fieldSources: Record<string, string>` (field → change id).
  - `POST /api/changes/{id}/revert` is moderators only (others 404). It creates and approves a new change whose `payload = { revertOf: id }` and applies the stored inverse. It answers 409 `has_dependents` if later changes depend on it. Reverting a change twice is 409 `already_reverted`.
  - `GET /api/search?q&kind?&mediaType?&cursor` is public. It matches `normalizeTitle(q)` against `works.search` (prefix `:*` on the last term) and against `title_norm` and `name_norm` with `like`, for the other kinds. Results are `Summary[]`, excluding merged and removed entities.
  - `GET /api/duplicates?kind&title&mediaType?` is public. It returns `{ existing: Summary[], pending: { kind, title, mediaType, releaseYear }[] }`. `pending` lists matching `pending` create changes, exposing only those four fields (spec §5.3).

- [ ] **Step 1: Write the failing tests**
  - `history.test.ts`:
    - `history lists approved changes newest first and omits pending and rejected ones`.
    - `fieldSources points title at the change that last set it`.
    - `revert restores the previous title and appears in history with revertOf`.
    - `a contributor calling revert gets 404`.
  - `search.test.ts`:
    - `"amelie" finds "  Amélie "` (Review Focus 5).
    - `search skips merged entities`. Mark it `it.todo` until Task 7, then enable it there.
    - `duplicates shows a pending create's title, mediaType and year, and nothing else`: assert the exact key set `['kind', 'mediaType', 'releaseYear', 'title']`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the code above.
- [ ] **Step 4: Run** the tests, `pnpm openapi:dump` and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): public history, revert, search and the duplicate check`

---

### Task 7: Merging and permanent IDs

**Files:**
- Modify: `features/changes/apply.ts`, `features/catalog/*`
- Test: `apps/api/test/merge.test.ts`

**Interfaces:**
- Merge apply (`op: 'merge'`, same `kind` required, else 400 `kind_mismatch`):
  - repoints every active relation from `from` to `into` (dropping ones that would duplicate an existing active relation by marking them `removed_by_change`);
  - sets `entities.merged_into_id = into` on `from`;
  - records `movedRelationIds` in the inverse.
  - Merging into an entity that is itself merged resolves to the winner. Merging an entity into itself is 400 `self_merge`.
- `GET /api/entities/{id}` for a merged id answers 308 with `Location: /api/entities/{winnerId}` and body `{ redirectTo: winnerId }`. The same applies to `/history`.

- [ ] **Step 1: Write the failing tests**
  - `after merging two creators, the loser's id redirects with 308 and the winner lists both works`.
  - `a pending update to the loser, approved after the merge, changes the winner` (Review Focus 3).
  - `reverting a merge restores both entities and their relations`.
  - Enable `search skips merged entities` from Task 6.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the code above.
- [ ] **Step 4: Run** the tests, `pnpm openapi:dump` and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): merge duplicates with permanent redirecting ids`

---

### Task 8: Redaction and anonymous claim

**Files:**
- Modify: `features/changes/*`, `features/users/*`, `features/catalog/*`
- Test: `apps/api/test/{redaction,claim}.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/admin/changes/{id}/redact` `{ reason (1–1000), removeEntity?: boolean }`. Admin only (others 404). It sets `redacted_at` and `redaction_reason`, and replaces `payload`, `base` and `inverse` with `null`. That needs the columns to be nullable; adjust them in this task's migration.
    - If the change's content is still current, the admin must also pass `removeEntity: true`, which sets `entities.removed_at`. Otherwise the answer is 409 `content_is_current`.
  - `GET /api/entities/{id}` for a removed entity is 410 with error code `removed`, and is excluded from search and duplicates.
  - `POST /api/me/claim-anonymous` requires a session and an `x-amdb-anon` header. It moves every submission with that anon hash to the user and returns `{ claimed: number }`. A second claim of the same token returns `{ claimed: 0 }`.

- [ ] **Step 1: Write the failing tests**
  - `redaction.test.ts`:
    - `a redacted change shows in history as redacted with its reason and no payload`.
    - `redacting a current value without removeEntity is 409`.
    - `a removed entity answers 410 and leaves search`.
    - `a moderator calling redact gets 404`.
  - `claim.test.ts`:
    - `after claiming, the user sees the anonymous submissions in /api/me/submissions and the old anon token gets 404`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the code above.
- [ ] **Step 4: Run** the tests, `pnpm openapi:dump` and `pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): redact removed content and let contributors claim anonymous work`
