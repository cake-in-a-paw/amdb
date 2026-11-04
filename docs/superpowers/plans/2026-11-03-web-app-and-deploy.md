# AMDB Web App and Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public AMDB website at `https://amdb.ty-pe.com` where anyone can browse and search the
catalog, contributors (anonymous or signed in) can add and edit entries with drafts and the
duplicate check, and moderators work the queue — served by the plan 1 API from one Railway
service.

**Architecture:** `apps/web` is a React SPA in the shape of `~/dev/rmd/apps/web` (rmd ADR 0007),
talking to the API only through a client generated from the OpenAPI snapshot
(`@amdb/shared/api`). Web tests drive the real API in process (`createApp` on PGlite) through
that client, so nothing is faked except Better Auth's browser client. In production the API serves
the built SPA from the same origin. A few API additions come first: public handles, browse,
related works, and the fixes needed before going public.

**Tech Stack:** As plan 1, plus React 19, Vite 8, TanStack Router and Query, Tailwind 4, shadcn
(Radix), sonner, lucide-react, Testing Library + jsdom, openapi-typescript + openapi-fetch, the
`railway` IaC SDK. Pin the exact versions rmd uses (`~/dev/rmd/apps/web/package.json`,
`~/dev/rmd/packages/shared/package.json`); fonts are new (Task 5).

**Spec:** `docs/superpowers/specs/2026-11-02-amdb-design.md`

**Owner decisions for this plan (2026-11-03):** domain `amdb.ty-pe.com` (DNS on Cloudflare);
production environment only, deployed from `main`; repo `cake-in-a-paw/amdb`, public; the look is
the builder's call with a "reference work" feel (Task 5).

**Plan series (updated).** 1 foundation (done) · **2 this plan** · 3 importers *and images*:
Wikidata and Open Library, plus the Railway bucket, CC0 image uploads with license and source,
and Commons covers (spec §4.4; not assigned to any plan until now) · 4 API keys, metering and
credits · 5 dumps.

## Global Constraints

- Everything from plan 1's Global Constraints still holds (CC0, `apply.ts` owns catalog writes,
  404-not-403, one error shape, `text` value lists, exact versions, American English, signed
  Conventional Commits). Add scope `web`.
- The web app never hand-writes API types; it imports them from `@amdb/shared/api`. Every task
  that changes the API regenerates `apps/api/test/fixtures/openapi.snapshot.json` **and**
  `packages/shared/src/api/schema.ts` in the same commit (the drift test from Task 4 fails
  otherwise).
- No email address and no OAuth profile name (`users.name`) appears in any response visible to
  anyone but the account itself. Public attribution is the opt-in `handle` or the word
  "contributor".
- Web tests use the real API in process (Task 5 harness). Only the Better Auth browser client is
  stubbed, injected through router context. No `vi.mock` of modules.
- Every screen that loads data renders explicit loading, error and empty states (constitution XI).
- Accessibility floor (rmd's): every control is reachable by keyboard with a visible 2px focus
  ring, has an accessible name, and is at least 44×44px; text meets WCAG AA contrast in both
  themes.
- Light and dark themes from `prefers-color-scheme`.
- Outward-facing actions (creating the GitHub repo, pushing, creating Railway resources, writing
  DNS, setting secrets) happen only in Task 11 and only after the owner confirms at that moment.

## Review Focus

1. **A draft is never lost.** A contributor (anonymous too) types a new entry, reloads, and it's
   still there. A submit that fails (network error, 400, 429) keeps the draft and the form; only a
   201 clears it. (Task 8)
2. **Anonymous work follows the contributor.** The browser creates one anonymous token, sends it
   on every write, and after sign-in claims once, then rotates the token so later signed-out work
   from the same browser isn't attached to the account. The claimed work shows in "My
   submissions". (Task 6)
3. **Old and removed links.** Opening a merged id lands on the winner's page with the URL
   replaced; a removed id (410) says the entry was removed, not "not found". (Task 7)
4. **An edit based on stale data.** Two people edit the same field; the second approval answers
   `stale_change`, and the moderator sees a plain message with the current value, not a raw code.
   The contributor's own edit form sends only the fields they changed. (Tasks 9, 10)
5. **The duplicate check while typing.** Typing "  amelie " shows existing *Amélie* and a pending
   *Amélie* submission labeled "pending" with no author, debounced so typing doesn't fire a
   request per keystroke. (Task 8)

---

## File Structure

```
apps/api/src/features/users/        + handle, /api/me, admin user lookup
apps/api/src/features/catalog/      + browse, related works
apps/api/src/platform/http/spa.ts   serve the built SPA with fallback (Task 3)
apps/api/test/helpers/setup.ts      exported to the web tests as @amdb/api/testing
packages/shared/src/api/            schema.ts (generated), client.ts (createApiClient)
apps/web/                           @amdb/web
  src/main.tsx, router.tsx, styles.css, routeTree.gen.ts (generated, committed)
  src/lib/        api.ts, auth.ts, anon.ts, drafts.ts, errors.ts (API error → words)
  src/components/ ui/ (shadcn), app-shell, search-box, entity-*, change-*, field editors
  src/routes/     __root, index, browse, search, entities.$id, entities.$id.history,
                  submit, entities.$id.edit, me.submissions, account, sign-in,
                  moderation.index, admin.users
  test/           harness.tsx (real API + render), *.test.tsx
.railway/railway.ts                 production environment (Task 11)
docs/decisions/0004-web-stack.md, 0005-railway-deployment.md
```

---

### Task 1: Public identity and the account endpoint

**Files:**
- Modify: `apps/api/src/platform/db/schema.ts` (`users.handle`), new migration
- Modify: `apps/api/src/features/users/{routes,service,repository,schemas}.ts`
- Modify: `apps/api/src/features/changes/{repository,schemas}.ts` (author shape in history and queue)
- Test: `apps/api/test/me.test.ts`, extend `privacy-emails.test.ts`, `roles.test.ts`

**Interfaces:**
- Produces: `GET /api/me` → `{ id, email, handle: string|null, role }` (401 `unauthenticated`
  when signed out); `PATCH /api/me` body `{ handle: string|null }`; `GET /api/admin/users?email=`
  → `{ items: [{ id, email, handle, role }] }` (admin only, else 404); `AuthorSchema =
  'anonymous' | { userId, handle: string|null }` used by history items and queue items.

- [ ] **Step 1: Write failing tests**
  - `me.test.ts`: signed-out `GET /api/me` → 401; signed-in returns own email and role;
    `PATCH` sets a handle; handle rules: 3–30 chars of `[a-z0-9_-]`, stored lowercase, unique
    case-insensitively (second account taking `Ann` after `ann` → 409 `handle_taken`), reserved
    `anonymous`, `contributor`, `admin`, `moderator` → 400 `handle_reserved`; `null` clears it.
  - `privacy-emails.test.ts`: create a user whose `name` is `"Real Name"` and email
    `real@example.com`; after they submit and a moderator approves, the history response and the
    entity response contain neither string; history author is `{ userId, handle: null }`, then
    `{ userId, handle: 'ann' }` after they set one.
  - `roles.test.ts`: `GET /api/admin/users?email=` as moderator → 404, as admin → match;
    **M7:** the last admin demoting themselves → 409 `last_admin`.
- [ ] **Step 2: Run, see them fail** — `pnpm --filter @amdb/api test me privacy roles`
- [ ] **Step 3: Implement.** `users.handle` is `citext` unique nullable (migration via
  `db:generate --name users-handle`). Handles validated by a `Handle` schema in `@amdb/shared`
  (value-list rule). The queue and history repositories left-join `users` for `handle` only.
- [ ] **Step 4: Run tests; refresh the OpenAPI snapshot** (README command); `pnpm --filter @amdb/api test`
- [ ] **Step 5: Commit** `feat(api): public handles and the account endpoint`

### Task 2: Browse and related works

**Files:**
- Modify: `apps/api/src/features/catalog/{routes,service,repository,schemas}.ts`
- Test: `apps/api/test/browse.test.ts`, `apps/api/test/related.test.ts`, extend `search.test.ts`

**Interfaces:**
- Produces: `GET /api/browse?kind=&mediaType=&cursor=&limit=` → `SearchSchema` (same item and
  cursor shape as search), ordered by normalized title then id; `kind` required, `mediaType` only
  with `kind=work` (400 otherwise). Work views gain `relations.related`:
  `{ byCreator: [{ creator: Summary, works: Summary[] }], bySeries: [{ series: Summary, works: Summary[] }], byProperty: [{ property: Summary, works: Summary[] }] }`
  — each `works` excludes the work itself, at most 12, ordered by release year then title.

- [ ] **Step 1: Write failing tests**
  - `browse.test.ts`: three works and a creator; `kind=work` lists the three in title order,
    `limit=2` pages with a cursor; `kind=creator` lists the creator; merged, retracted and removed
    entities never appear; `mediaType=book&kind=creator` → 400.
  - `related.test.ts`: work A and B share a creator, A and C share a series, A and D share a
    property: A's view has B under `byCreator`, C under `bySeries`, D under `byProperty`, never A
    itself; a 13th work by the creator is cut at 12; a merged-away or removed work is absent.
  - `search.test.ts` (**M9**): an original title `"Le Fabuleux Destin d'Amélie Poulain"` is found
    by `q=amelie poulain`.
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement.** Browse reuses search's ordering and cursor (`SearchCursor`). Related
  is three queries over active relations, filtered like search (not merged, retracted or removed).
  M9: normalize `original_title` the same way as `title` (new `original_title_norm` column with a
  backfill in the same migration).
- [ ] **Step 4: Run tests; refresh the snapshot**
- [ ] **Step 5: Commit** `feat(api): browse listings and related works`

### Task 3: Ready for the public, and serving the SPA

**Files:**
- Modify: `apps/api/src/features/changes/{routes,service}.ts` (M8, M4, M5)
- Create: `apps/api/src/platform/http/spa.ts`
- Modify: `apps/api/src/{app.ts,env.ts,server.ts}`, `.env.example`
- Modify: `docs/superpowers/specs/2026-11-02-amdb-design.md` (Production Annotations)
- Test: extend `submissions.test.ts`, `moderation.test.ts`; create `apps/api/test/spa.test.ts`

**Interfaces:**
- Produces: `AppDeps.webDistDir?: string`; env `WEB_DIST_DIR` (optional).

- [ ] **Step 1: Write failing tests**
  - **M8:** anonymous `POST /api/changes/{id}/resubmit` draws on the same per-token and per-IP
    limit as submit (21st in an hour → 429 with `Retry-After`).
  - **M5:** a create whose tag slug or external id (scheme + value) already exists answers 409
    `duplicate_slug` / `duplicate_external_id` with `details.existingId`, at submit when it
    already exists and at approve when it appeared meanwhile.
  - **M4:** redacting a change whose content is still live without `removeEntity` answers 409
    `content_is_current` with a message naming `removeEntity: true`.
  - `spa.test.ts` with a temp dir holding `index.html` and `assets/app.js`: `GET /` and
    `GET /entities/<uuid>` return `index.html` (`text/html`); `GET /assets/app.js` returns the
    file with a long `cache-control`; `index.html` is `no-cache`; `GET /api/nope` is still the
    JSON 404 error shape; without `webDistDir`, `GET /` is the JSON 404.
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement.** `spa.ts` exports `serveSpa(dir: string)`, a Hono sub-app using
  `@hono/node-server/serve-static` (already a dependency), mounted last in `createApp` for
  non-`/api` GETs. `server.ts` passes `env.WEB_DIST_DIR`.
- [ ] **Step 4: Production Annotations.**
  - Delete the line about migrations 0005 and 0006. Ruling: production starts from an empty
    database, where those migrations apply cleanly; there is no populated database to backfill.
  - Add these lines:
    - *Reads are public until plan 4.* Spec §7 wants an API key on reads. Plan 2 deploys reads
      without a key. Plan 4 adds keys and metering.
    - *No bot protection on anonymous writes.* Hold-all means spam reaches only the moderators'
      queue, and a per-address limit caps it. Add a challenge (e.g. Turnstile) if the queue
      fills.
- [ ] **Step 5: Run `pnpm check`; refresh the snapshot; commit** `feat(api): serve the web app and close pre-launch gaps`

### Task 4: The typed API client

**Files:**
- Modify: `packages/shared/package.json` (`exports["./api"]`, `gen:api` script, deps)
- Create: `packages/shared/src/api/schema.ts` (generated), `packages/shared/src/api/client.ts`,
  `packages/shared/test/api-drift.test.ts`
- Modify: `.prettierignore`, `.oxlintrc.json` (ignore `schema.ts`), `README.md`

**Interfaces:**
- Produces: `createApiClient(opts: { baseUrl?: string; fetch?: typeof fetch; headers?: () => Record<string, string> }): Client<paths>`
  from `@amdb/shared/api`, plus `type paths`, `type components`. `headers()` runs per request
  (the web app uses it for `x-amdb-anon`).

- [ ] **Step 1: Write the drift test**: it runs `openapi-typescript` on the snapshot into a temp
  file and asserts it equals the committed `schema.ts` (rmd's pattern; read
  `~/dev/rmd/packages/shared` for it).
- [ ] **Step 2: Add `openapi-typescript` 7.13.0 (dev) and `openapi-fetch` 0.17.0; run
  `pnpm --filter @amdb/shared gen:api`; implement `client.ts`; a test that `headers()` is sent.**
- [ ] **Step 3: README: "After an API change, refresh the snapshot, then `gen:api`".**
- [ ] **Step 4: `pnpm check`; commit** `feat(shared): typed API client generated from OpenAPI`

### Task 5: Web app scaffold, look, and the test harness

**Files:**
- Create: `apps/web/**` (package.json, vite and vitest configs, tsconfig, index.html,
  components.json, `src/{main,router}.tsx`, `src/styles.css`, `src/routes/{__root,index}.tsx`,
  `src/components/app-shell.tsx`, `src/components/ui/*` as needed, `src/lib/{api,auth}.ts`,
  `test/{setup.ts,harness.tsx,app.test.tsx,a11y-floor.test.tsx}`)
- Modify: `apps/api/package.json` (`exports["./testing"]` → `test/helpers/setup.ts`)
- Create: `docs/decisions/0004-web-stack.md`
- Modify: `README.md`, `.prettierignore`, `.oxlintrc.json`

**Interfaces:**
- Consumes: `createApiClient` (Task 4); `setupTest()` and its actors from
  `apps/api/test/helpers/setup.ts`.
- Produces: router context `{ api: ApiClient; auth: AuthClient; queryClient }`;
  `renderApp(path: string, opts?: { as?: 'anonymous' | 'contributor' | 'moderator' | 'admin' }): Promise<{ user, router, api, db }>`
  in `test/harness.tsx`, which builds `createApp` on a fresh PGlite and hands `app.fetch`
  (wrapped so a relative URL resolves) to `createApiClient`, with a stub auth client whose session
  matches `as`. Also `seed(api)` helpers for a few works, creators and links.

- [ ] **Step 1: Probe the harness first.** Write `app.test.tsx`: `renderApp('/')` shows the site
  name and a search box; a seeded work's title appears on the home page's "Recently added" list.
  If PGlite or the Fetch `Request` misbehaves under jsdom, try `// @vitest-environment` per file
  or a `node`-environment API with a jsdom render. If neither works, fall back to rmd's fake API
  (`~/dev/rmd/apps/web/test/fake-api.ts`) and record why in ADR 0004. Decide before Step 3.
- [ ] **Step 2: Scaffold** from rmd's web app config: same versions and same `/api` proxy on
  5173 with `strictPort`. Use the same `@/` alias and commit `routeTree.gen.ts`. Add
  `apps/web` to `pnpm check` and to CI, which runs it already through `pnpm -r`.
- [ ] **Step 3: The look** (load the `frontend-design:frontend-design` skill). Aim for a
  "reference work" feel: a dense, quiet, typographic library catalog, not an app-store grid.
  - Fonts: a serif for titles and a sans for interface text, self-hosted with `@fontsource-variable`.
  - Semantic color tokens on `:root`, with a dark set under `prefers-color-scheme`, mapped onto
    shadcn's variables (rmd ADR 0007's token swap).
  - A focus ring from one base-layer rule.
  - The app shell: header with the AMDB wordmark, search, Browse, Contribute, a sign-in or
    account menu, and a Moderation link for moderators. Footer: "All data CC0", with dumps
    "coming soon".
  - Record the fonts, tokens and rationale in ADR 0004.
- [ ] **Step 4: `a11y-floor.test.tsx`** in the shape of rmd's: every button and link in the
  shell has an accessible name and the `min-h-11 min-w-11` classes.
- [ ] **Step 5: ADR 0004** (rmd ADR 0007's table, plus the fonts and the harness decision).
- [ ] **Step 6: `pnpm check`; commit** `feat(web): app shell, look and real-API test harness`

### Task 6: Sign-in, anonymous identity, claim, and the account

**Files:**
- Create: `apps/web/src/lib/anon.ts`, `src/routes/{sign-in,account,me.submissions}.tsx`,
  `src/components/{sign-in-buttons,email-sign-in,passkey-offer,change-status}.tsx`
- Test: `apps/web/test/{anon,sign-in,account,my-submissions}.test.tsx`

**Interfaces:**
- Produces: `getAnonToken(): string` (creates and stores a 32-byte random token in
  `localStorage['amdb.anon']` on first use; storage failures fall back to an in-memory token for
  the tab), `rotateAnonToken(): void`. The API client's `headers()` sends `x-amdb-anon` only when
  signed out. `ChangeStatus` component: `pending | published | approved | rejected` in words with
  the rejection reason.

- [ ] **Step 1: Write failing tests**
  - `anon.test.ts`: the same token across calls; rotate gives a new one; `localStorage` throwing
    still yields a token.
  - `sign-in.test.tsx`: email code flow (address → code → signed in) against the auth stub;
    Google and GitHub buttons call the stub's social sign-in with a callback to the page the user
    came from; passkey offer after first sign-in (rmd's pattern).
  - **Review Focus 2**, `my-submissions.test.tsx`:
    - An anonymous submission is made through the API with the browser's token.
    - The user signs in, and the app calls `POST /api/me/claim-anonymous` exactly once.
    - The token is rotated.
    - The submission is listed under "My submissions" with status "Waiting for review".
    - A rejected change shows its reason and a "Fix and resubmit" link (Task 9 provides the form;
      here, assert the link).
  - `account.test.tsx`: set a handle; 409 `handle_taken` shows "That handle is taken"; clear it.
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement** with Better Auth's client (`better-auth/client`, passkey plugin) as rmd
  does, injected via context. The claim runs from the root route when a session appears and the
  stored token has not yet been claimed. Store `amdb.anon.claimed` with the token, so a reload
  doesn't call it twice.
- [ ] **Step 4: Run tests; `pnpm check`; commit** `feat(web): sign-in, anonymous identity and my submissions`

### Task 7: The public browser

**Files:**
- Create: `apps/web/src/routes/{browse,search,entities.$id,entities.$id.history}.tsx`,
  `src/components/{entity-header,work-page,list-page,related-works,history-list,entity-states,load-more,search-box}.tsx`,
  `src/lib/errors.ts`
- Test: `apps/web/test/{browse,search,work-page,list-pages,history,entity-states}.test.tsx`

**Interfaces:**
- Consumes: `/api/browse`, `/api/search`, `/api/entities/{id}` (+ `related`), `/api/entities/{id}/history`.
- Produces: `describeError(error: ApiError): string`, where `ApiError` is the generated
  `components['schemas']['Error']` plus the HTTP status and `Retry-After`. This is the one map from API error codes to
  plain words, used by every later form.

- [ ] **Step 1: Write failing tests**
  - `work-page.test.tsx`:
    - A seeded work shows its title and creators with their roles.
    - The release date shows at the precision given (year, or month and year).
    - The description, tags and lifecycle show.
    - The related groups show: "More by <creator>", "In <series>" with positions, "Also in
      <property>", and direct links in words ("Adapted from", "Sequel to").
    - With no cover, a typographic placeholder shows the title.
    - The page offers "Edit" and "History".
  - `list-pages.test.tsx`: creator, series, property and tag pages list their works. A series
    page lists its works in position order.
  - `browse.test.tsx`: tabs for Works, Creators, Series, Properties and Tags. A media-type filter
    on works. "Load more" follows the cursor. Empty state: "Nothing here yet — add the first one",
    linking to Contribute.
  - `search.test.tsx`: the header search box goes to `/search?q=`. Results are grouped or labeled
    by kind. "amelie" finds *Amélie*. A query with no results offers "Add it".
  - **Review Focus 3**, `entity-states.test.tsx`:
    - A merged id replaces the URL with the winner's (`router.state.location` shows the winner)
      and renders its page.
    - A removed id (410) shows "This entry was removed" and no fields.
    - An unknown id shows "Not found".
    - A network error shows a retry button.
  - `history.test.tsx`:
    - Changes are listed newest first, with author (handle, "contributor" or "anonymous"),
      when, and what changed.
    - A redacted item shows "Removed: <reason>" and no content.
    - Moderators see a "Revert" button. Others don't.
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement.** The 308 is followed by `fetch`. Detect it by comparing the returned
  entity id with the requested one, then `router.navigate({ replace: true })`. Lists use TanStack
  Query infinite queries.
- [ ] **Step 4: Run tests; `pnpm check`; commit** `feat(web): public browser, entry pages and history`

### Task 8: The submission tool

**Files:**
- Create: `apps/web/src/lib/drafts.ts`, `src/routes/submit.tsx`,
  `src/components/{entry-form,work-fields,relation-picker,duplicate-check,cc0-agreement,submission-result}.tsx`
- Test: `apps/web/test/{drafts,submit,duplicate-check}.test.tsx`

**Interfaces:**
- Consumes: `/api/duplicates`, `/api/search` (pickers), `POST /api/submissions`; per-kind field
  schemas from `@amdb/shared` (`fields.ts`) for client validation, so the form and the API agree.
- Produces:
  - `useDraft<T>(key: string, initial: T): [T, (next: T) => void, clear: () => void]`, backed by
    `localStorage['amdb.draft.<key>']`. Writes are debounced 500ms, and a storage failure keeps
    working in memory.
  - `buildSubmission(form: EntryForm): SubmissionInput` turns the form into `create` and `relate`
    changes, with `ref`s for new entities.

- [ ] **Step 1: Write failing tests**
  - `submit.test.tsx`:
    - A contributor creates a book with:
      - a new author, made inline through the creator picker's "Add new…", which becomes a second
        `create` with a ref;
      - an existing tag;
      - membership in an existing series at position 2;
      - an ISBN external id.
    - The submit button is disabled until the CC0 box is checked. Its label reads "I release this
      contribution into the public domain (CC0)".
    - The API receives one submission with the expected changes, and the result page lists each
      change with status "Waiting for review".
    - Client validation uses the shared schema, e.g. a day without a month shows a field error.
  - **Review Focus 1**, `drafts.test.tsx`:
    - The draft survives an unmount and remount, and works for an anonymous user.
    - A 429 shows "Too many submissions — try again in N minutes" (from `Retry-After`) and keeps
      both the draft and the form.
    - A rejected fetch keeps them too.
    - Only a 201 clears the draft.
  - **Review Focus 5**, `duplicate-check.test.tsx`:
    - With an existing *Amélie* and a pending *Amélie* create from another user, typing
      "  amelie " shows both.
    - The pending one is labeled "Pending review" with title, type and year only.
    - Typing five characters quickly makes one request (300ms debounce).
    - A match links to the existing entry, with "Edit this instead".
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement.** One form handles all five kinds, with fields chosen by kind and,
  for works, by media type. The relation pickers search with `/api/search` scoped by kind and
  offer "Add new…".
- [ ] **Step 4: Run tests; `pnpm check`; commit** `feat(web): submission tool with drafts and the duplicate check`

### Task 9: Editing existing entries, and resubmitting

**Files:**
- Create: `apps/web/src/routes/{entities.$id.edit,changes.$id.resubmit}.tsx`, `src/lib/diff.ts`
- Modify: `src/components/entry-form.tsx` (edit mode)
- Test: `apps/web/test/{edit,resubmit}.test.tsx`

**Interfaces:**
- Produces: `diffFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown>`
  (changed keys only; a cleared field is `null`); `buildEdit(entity: EntityView, form: EntryForm): ChangeInput[]`
  (one `update` with changed fields, plus `relate` for added relations and `unrelate` for removed
  ones).

- [ ] **Step 1: Write failing tests**
  - `edit.test.tsx`:
    - The form opens pre-filled from the entity.
    - Changing only the year sends `update` with `{ releaseYear }` alone, which is Review Focus 4's
      contributor half.
    - Removing a tag sends `unrelate` with its `relationId`.
    - Adding a creator sends `relate`.
    - No changes means the submit button is disabled.
    - The draft key is `edit.<entityId>`.
    - After submit, the entry page shows a "Your edit is waiting for review" notice, from the
      user's pending submissions for that entity.
  - `resubmit.test.tsx`: a rejected change opens with its reason shown and its payload pre-filled;
    submitting calls `/api/changes/{id}/resubmit` with the changed fields; the new change shows as
    waiting.
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run tests; `pnpm check`; commit** `feat(web): edit entries and resubmit rejected changes`

### Task 10: Moderation and admin

**Files:**
- Create: `apps/web/src/routes/{moderation.index,admin.users}.tsx`,
  `src/components/{queue-item,change-diff,reject-dialog,edit-approve-dialog,redact-dialog}.tsx`
- Test: `apps/web/test/{moderation,admin}.test.tsx`

**Interfaces:**
- Consumes: `/api/moderation/queue`, approve, reject, revert, redact, `/api/admin/users`, role.

- [ ] **Step 1: Write failing tests**
  - `moderation.test.tsx`:
    - Anonymous users and contributors get "Not found" at `/moderation`, and the shell has no
      Moderation link for them.
    - A moderator sees the queue oldest first, with each item's age ("3 days") and author (handle,
      "contributor" or "anonymous").
    - An update shows a before/after diff against the entity's current fields.
    - A create shows its fields.
    - A relate shows both ends by title.
    - Approve removes the item.
    - Reject requires a reason.
    - Edit-and-approve changes one field and approves.
    - A `dependency_pending` 409 says "Approve <title> first" and links to it.
    - **Review Focus 4 (moderator half):** a `stale_change` 409 says "This field changed since the
      edit was made" and shows the current value.
    - The queue pages with "Load more".
  - `admin.test.tsx`:
    - Find a user by email and make them a moderator.
    - `last_admin` shows "You're the last admin".
    - On a change in history, an admin can redact with a reason. When the content is live, the
      dialog explains it also takes the content down and sends `removeEntity: true`.
- [ ] **Step 2: Run, see them fail**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run tests; `pnpm check`; commit** `feat(web): moderation queue and admin tools`

### Task 11: Deploy to Railway

The runbook in this task includes actions only the owner can take or approve. **Stop and ask
before each outward step**: creating the repo, pushing, Railway project or config apply, DNS,
secrets.

**Files:**
- Create: `.railway/railway.ts`, `.railway/README.md`, `docs/decisions/0005-railway-deployment.md`,
  `docs/deploy.md` (the runbook)
- Modify: `README.md` (Deploy section), `.env.example` (`WEB_DIST_DIR`)

- [ ] **Step 1: `.railway/railway.ts`** in the shape of rmd's, with these differences:
  - One environment, `production`.
  - Service `app`, from `github('cake-in-a-paw/amdb', { branch: 'main', checkSuites: true })`.
  - Build `pnpm --filter @amdb/web build`, start `pnpm --filter @amdb/api start`.
  - Healthcheck `/api/health`.
  - Domain `amdb.ty-pe.com`.
  - Env: `DATABASE_URL` from the Postgres resource, `WEB_DIST_DIR: '../web/dist'`,
    `BETTER_AUTH_URL` and `WEB_ORIGIN` set to `https://amdb.ty-pe.com`, and
    `TRUSTED_PROXY_HOPS: '1'`.
  - `preserve()` for every secret **and for `ADMIN_EMAILS`**. The repo is public, so no address
    goes in the file.
  - No bucket. Images arrive in plan 3.
- [ ] **Step 2: ADR 0005** covers:
  - Production only, from `main`, gated on CI. Rejected: dev + production, as in rmd ADR 0008,
    because of cost and because there are no users yet. Add a dev environment when moderators
    work real data.
  - Migrations run at boot.
  - The Cloudflare record is **DNS-only (gray cloud)**, because a proxied record adds a hop to
    `X-Forwarded-For` and breaks `TRUSTED_PROXY_HOPS=1`.
- [ ] **Step 3: `docs/deploy.md` runbook**, in order. Each step has its verification.
  1. Confirm the Railway plan has a custom-domain slot. A trial account hit its limit before.
  2. Create the `cake-in-a-paw/amdb` public repo and push `main`, after checking that every
     commit is signed. Install the Railway GitHub app on the repo.
  3. Create the Railway project and apply it with `railway config plan`, then
     `railway config apply`.
  4. Create a Google OAuth client and a GitHub OAuth app, with callbacks at
     `https://amdb.ty-pe.com/api/auth/callback/{google,github}`.
  5. Verify a Resend sending domain (e.g. `amdb.ty-pe.com`) and set `EMAIL_FROM`.
  6. Set the secrets: `BETTER_AUTH_SECRET`, the OAuth ids and secrets, `EMAIL_API_KEY`,
     `EMAIL_FROM` and `ADMIN_EMAILS`.
  7. Add the domain with `railway domain amdb.ty-pe.com`, then write the Cloudflare `CNAME amdb`
     and the `_railway-verify` TXT record, both DNS-only.
  8. Smoke test:
     - `/api/health` returns ok.
     - The home page renders.
     - Sign in by email code. The admin account gets `admin`.
     - Submit an entry anonymously, approve it as admin, and see it on its page.
     - Requests from two different networks get separate anonymous rate-limit buckets.
- [ ] **Step 4: `pnpm check`; commit** `feat(ci): Railway production deployment` (scope `ci`)
- [ ] **Step 5: With the owner, walk the runbook one step at a time.** Ask before each outward
  action. Record the outcome of each step in the ledger, and update the hosting memory
  (`project_ty_pe_hosting.md`) once the site is live.

---

## Deferred from plan 1 (not in this plan)

Carried from the plan 1 build log so they survive:
- M1: re-check creator roles when a work's `mediaType` changes.
- M3: history for retracted entities, currently a 404.
- Redacting a clear-only (all-null) update counts as current content and requires `removeEntity`.
  Treat all-null updates as not current.
- A redacted published change's status never resolves. Decide this before plan 4, since credits
  key on approval.
- Retired relations get the placeholder role `[removed]`, which is outside the value list.
- The redaction scrub's value matching can strip identical common values from unrelated changes in
  a merge family.
- `requireEntities` retries after a mid-lock merge and can then lock out of id order. This is
  rare, and the result is a retryable error.
- Scrubbing a pending change's `base` keys drops its stale check on those keys.
- Removal's `cascadeReject` matches `entity_id` only, so relates naming the removed entity as `to`
  fail later, at approval.
- The architecture test misses `export … from` re-exports and dynamic `import()`.
- Test gaps:
  - `users.role` default, tags slug uniqueness and unknown relation types are untested.
  - `duplicate_ref`, `kind_mismatch` and `Retry-After` on 429 have no direct tests.
  - Removal of creator, series, property and tag kinds is untested.
- Search token mismatch for dotted and decimal titles. Merge dedupe ignores position, by design.
