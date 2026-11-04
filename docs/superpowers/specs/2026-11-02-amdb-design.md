# AMDB (All Media Database) — Design

- **Status:** Draft for review
- **Date:** 2026-11-02
- **Owner:** Tyler Peckenpaugh

## 1. Intent

AMDB is an open, crowd-sourced catalog of media (films, TV, anime, books, and later games,
board games and music) released into the public domain under **CC0**.

It exists so that developers building media apps have one catalog with **one integration
point, one license and one data shape** across every medium, instead of stitching together
several commercial databases, each with its own terms, retention limits and usage bans.
Tyler is building it to get ahead of that risk for his own app (rmd) and because it is a fun,
valuable thing to make. rmd will not use AMDB until AMDB is well populated; nothing in this
design depends on rmd.

**Who it's for.** The typical contributor is a developer building a similar app who sees that
a generously licensed, cross-media catalog helps them too. Anyone may browse the data for free.

**What success looks like.** Contributors add and improve entries, moderators keep quality up
without a growing backlog, and anyone can get the whole dataset (monthly dumps) or query it
live (API).

## 2. Goals, non-goals, anti-goals

**Goals (v1)**

- Media types: **movies, TV, anime** (anime is film/TV with an anime subtype, as in rmd) and
  **books**.
- A shared data model of works, creators, series, properties and direct links between works
  (§4).
- Four surfaces: submission and editing, moderation, a free public browser, and an API with
  credit-based usage (§5–§8).
- Free monthly CC0 data dumps.
- Seed data imported from CC0 sources: Wikidata (film, TV, anime) and Open Library (books),
  **English only** for now (§6.2).

**Non-goals (v1)**

- Music, video games, board games (the model must accommodate them later; §4.2).
- Selling API access (the credit system must leave room for it; §7).
- Recruiting moderators from the user base (moderators are Tyler and friends for now).
- Any integration with rmd.
- Volatile data: ratings, rankings, popularity.

**Anti-goals** — it would be a failure, even if it worked, if:

- **Contributors' effort is wasted.** This is the owner's explicit top concern. Duplicate
  work, lost drafts, silent rejections and stale queues are all failures (§5.3).
- Any non-CC0 content gets into the data, putting the license of the whole dataset in doubt.
- The API, browser and dumps disagree about what the data is.

## 3. Constraints

- **License.** All data is CC0. Every submission is accepted under CC0 (the contributor
  agrees at submit time, anonymous or not). Importers read only sources whose data is itself
  CC0, and the importer's spec records the source's license and the evidence for it.
  - Consequence: copyrighted cover art, posters, publisher blurbs and Wikipedia text
    (CC BY-SA) can't be copied in. Descriptions are written by contributors (or come from a
    CC0 source). See §4.4 for images.
- **Stack: the same as rmd.** pnpm monorepo; `apps/api` (Hono, Drizzle, Postgres, Better
  Auth, zod-openapi), `apps/web` (React, Vite, TanStack Router and Query, Tailwind),
  `packages/shared` (value lists, generated API client). PGlite for local dev and tests.
  Deployed on Railway. Same tooling: Prettier, oxlint, husky, Conventional Commits, CI running
  `pnpm check`. See `~/dev/rmd` for the reference setup (README, ADRs 0002, 0004, 0005, 0007,
  0008).
- **Spelling.** American English throughout, including `catalog` (rmd's `catalogue`
  exception does not carry over).

## 4. Data model

The shared data model is the heart of the project. The design below is agreed at the level of
entities and relationships; table and column details are left to the builder (§10).

### 4.1 Entities

- **Work** — one record per work of any media type: a film, a TV series, an anime series, a
  novel. Shared core fields: title, original title, release date (year, optional month and
  day, as in rmd), description, cover (§4.4), tags, lifecycle (`released | upcoming | airing |
  unknown`), media type and subtype.
- **Creator** — a person or organization, as a record of its own (not a text string on the
  work), so "more by this creator" works across media. A work has many creators, each with a
  **role**. Roles are a fixed value list per media type (director, writer, author, studio,
  illustrator, translator, …).
- **Series** — an ordered set of works in one line (a trilogy, a book series, a show's
  seasons if modeled as works). Usually within one medium. Each membership has a position.
- **Property** (IP / franchise) — an umbrella grouping works across media (e.g. *Dune*: the
  novels, the films, the series). A work may belong to a series and a property at once.
- **Work-to-work link** — a typed, directed relationship between two specific works:
  `adapted_from`, `sequel_of`, `prequel_of`, `remake_of`, `spin_off_of`, `expansion_of`
  (final list is the builder's, extensible).
- **Tag** — a controlled vocabulary with kinds (genre, theme, content warning, …), as in rmd.
- **External identifiers** — a work or creator may carry identifiers in other systems
  (Wikidata QID, Open Library ID, ISBN, IMDb ID, …). These are facts, not dependencies, and
  are how importers match and how developers join AMDB to their own data.

### 4.2 Media types

- Each media type adds its own fields to the shared core (episode count and runtime for TV;
  page count and ISBN-bearing editions for books; player count for board games later).
  In rmd these live in a per-media-type validated `attributes` jsonb; the builder may keep
  that pattern.
- v1 media types: `film_tv` (subtypes `movie`, `series`, `anime_series`, `anime_film`) and
  `book`. Adding `music_album`, `video_game` or `board_game` later must be an additive change.
- **Books: work vs. edition.** Whether v1 models editions (a specific printing with its own
  ISBN) separately from the work is left to the builder; ISBNs must be storable either way.

### 4.3 Provenance and history

- **Every change is a revision.** Creating or editing any entity, link or field produces a
  revision recording who made it (account, or anonymous), when, its source (human, or which
  importer run), and its review outcome. No write bypasses this — imports and moderator fixes
  included.
- History is append-only. A revert is a new revision. Each entity's history is public
  (anonymous authors shown as anonymous).
- Every field's current value can be traced to the revision that set it, and so to its
  source. This is what lets AMDB stand behind its CC0 claim. *(Builder's call how: an import
  run may write one revision per entity rather than one per field, as long as the trace
  holds.)*
- **Public history shows approved revisions only.** Pending and rejected changes are visible
  to their author and to moderators, not to the public (§5.3 has the one exception).
- **IDs are permanent.** AMDB IDs are promised to developers as stable. *(My call.)*
  - **Merging is in v1.** Merging a duplicate into another entity is a revision. The losing
    ID keeps resolving and redirects to the winner, in the API, the browser and the dumps.
  - **Removal for legal or abuse reasons** is the one exception to append-only content. The
    revision stays in the history as a stub (who, when, "removed: reason"), but its content is
    erased. The entity's ID resolves to a "removed" response, not a 404 for an unknown ID.

### 4.4 Images

Covers are expected on entries, but most cover art is copyrighted. **v1 provisional rule:**
AMDB hosts only images whose license is CC0 or public domain, recorded per image with its
source; otherwise the work has no cover. Hosted images are stored in a Railway bucket, as in
rmd (ADR 0011).

## 5. Submission and editing

### 5.1 Who can submit

- Anyone, **anonymously** or with an **account**. Accounts use Better Auth as in rmd (email
  code, Google, GitHub; passkeys optional).
- Every submission agrees to CC0.
- Anonymous submissions are rate-limited and protected against bots (mechanism left to the
  builder).

### 5.2 What can be submitted

- New works, creators, series, properties, and links between them.
- **Edits to existing entries from the browser.** Anyone viewing an entry can add or correct
  information from that page. The browser and the submission tool overlap.
- *Likely needed (assumption):* developers will want to contribute **in bulk**. v1 must at
  least not preclude a bulk path (e.g. submitting a batch through the API); whether v1 ships
  one is the builder's call.

### 5.3 Not wasting contributors' effort

- **Duplicates caught before submitting.** While a contributor types a title, the form shows
  matching existing entries *and pending submissions*. For a pending submission the check
  reveals only its title, media type and year, plus the fact that it's pending. It never
  shows the author or the other fields. This is the one public view of pending data, and the
  privacy tests cover exactly that. *(My call.)*
- **Drafts are saved**, including for anonymous users (in their browser).
- **Rejection returns work, never deletes it.** A moderator gives a reason; the contributor
  can fix and resubmit.
- **Small reviewable units.** A submission is split into changes a moderator can approve or
  reject independently (approve the work, reject one bad link), so one questionable field
  doesn't block the rest.
- **Anonymous work can be claimed.** If someone submits anonymously and then signs up from the
  same browser, their pending and approved anonymous submissions (and their credit) move to
  the new account.
- Contributors can see the status of everything they submitted.

## 6. Moderation

- Moderators are Tyler and friends at launch, granted by an admin. Recruiting from the user
  base (by interview) comes later; the role model should not need to change for it.

### 6.1 Review policy (expect to iterate)

The owner has said that *when* a change goes live is the part most likely to need rework
and tuning, so the design must make it easy to change.

- **v1 rule: hold until approved.** Every human change, anonymous or not, waits for a
  moderator before it goes live and before it earns credit. *(My call, matching the original
  brief: "users submit entries for moderation".)*
- **Make the rule one swappable unit.** Whether a change waits, goes live, or goes live and
  gets reviewed afterward is decided in one place: a review-policy function that takes the
  change, its author and its context and returns a decision. The rest of the system
  (current state, the queue, credits, the browser's "your edit is pending" view) reacts to
  that decision and never repeats the rule.
- **Support both "hold" and "live, review after" from the start**, even though v1 uses only
  "hold". Switching rules must not need a data migration.
- **Likely first new rule (owner's idea):** auto-approve a change when more than one
  independent user submits the same change. That means the design needs a way to recognize
  when two pending changes are the same change. v1 doesn't need to ship this rule. *(The
  builder should note that anonymous submitters make "independent" easy to fake, so a
  corroboration rule will likely count only signed-up accounts. Whoever implements it must
  also decide whether a change it auto-approves earns credit. If it does, sock-puppet
  accounts could farm credits.)*

### 6.2 Seed imports

- **Seed size.** Import English-only items: Wikidata film, TV and anime items with an
  English label, and Open Library works with English-language editions. No hosting budget is
  set. Size the infrastructure for that subset, but load in batches so a larger import later
  doesn't need a redesign.
- **Open Library fields.** Open Library contributions are dedicated under CC0 1.0 (Creative
  Commons case study), but its descriptions are sometimes pasted publisher copy and its
  covers aren't CC0. Import only factual fields: titles, authors, dates, subjects and
  identifiers (ISBN, OLID). Don't import descriptions or covers. The importer's spec
  re-checks Open Library's current license wording. *(My call.)*
- **Wikidata fields.** Import structured statements, labels and short descriptions (CC0).
  Don't import Wikipedia text (CC BY-SA). Import Commons images only per §4.4.
- A queue of pending changes, showing each change's age so the backlog stays visible.
- Actions per change: approve, reject with a reason, or edit-and-approve (the edit is its own
  revision). Moderators can revert any revision.
- **Imported data does not go through the per-record queue.** Importer runs write revisions
  attributed to the importer and its source, already approved; moderators can review and
  correct them like anything else. (Moderators can't review millions of seed records one by
  one.)

## 7. API, credits and access

- A public REST API with an OpenAPI document (as in rmd). Its reads serve exactly what the
  browser shows (§8). *(My calls below.)*
- **Reads** need an API key and are metered (below).
- **Writes** (submissions, edits) are part of the same documented API. They're free, never
  spend credits, and earn credits once approved. The web app's submission tool uses these
  endpoints. Anonymous writes go through the web app, without a key and rate-limited. Bulk or
  programmatic writes need a signed-in account (a key or session).
- **The browser isn't metered.** The web app reads through the same endpoints using its own
  session, rate-limited per client (IP) rather than charged credits. If someone scrapes the
  browser instead of using the API, that's acceptable, since the full data is in the free
  dumps anyway. What the API sells is convenience and freshness, not exclusivity.
- **Access by request.** A signed-up contributor requests an API key; a moderator or admin
  grants it.
- **Usage accounting:**
  - Every approved API user gets a small **free monthly allowance**, used first.
  - Beyond that, requests draw on the user's **credit balance**.
  - **Credits are earned only when a change is approved.** Pending and rejected changes earn
    nothing.
  - **Points scale with what a change adds** (a new work with creators and links earns more
    than fixing a date). Point values are a configurable table, not hard-coded.
  - Points convert to requests at a fixed, configurable rate (starting idea: 1 point =
    1,000 requests). The balance does not expire.
  - All numbers are placeholders to be tuned from real usage.
- Selling access later should be an additive change: paid requests are another way to top up
  the same balance.
- The free monthly dumps never require credits.

## 8. Public browser

- Free, no account needed. Search and browse works, creators, series and properties.
- A work's page shows: title, creators (with roles), release date, cover, description, tags,
  and related works — same creator, same series, same property, and direct links.
- Each entry's page offers editing (§5.2) and its public history (§4.3).

## 9. Data dumps

- Monthly, free, CC0, downloadable without an account.
- A dump is a snapshot of exactly the data the API served at that point (constitution
  principle 4). Format is the builder's call; it must be documented and stable across months.
- Contents: current approved data, approved history, and merge redirects. Not included:
  pending and rejected changes, emails, API usage, credit balances, and content removed for
  legal or abuse reasons.

## 10. Constitution

Before any code, the repo gets a constitution, `CLAUDE.md` (with `AGENTS.md` linking to it)
and its ADR (0003), in the same form, length and governance as rmd's (see
`~/dev/rmd/CLAUDE.md` and `~/dev/rmd/docs/decisions/0003-constitution.md`).

**Carried over from rmd, adapted only where AMDB differs:** tests run against real Postgres
and are never weakened; simple by default, uniform by rule; feature folders with three layers;
types and schemas are the contract; the database guards its invariants; one error shape;
dependencies are decisions; no dead architecture. The standards section (gates, PRs, commits,
spelling, shortcuts, ADRs) and governance (amendments by ADR, semver) carry over.

**Specific to AMDB:**

1. **Everything is CC0.** Every field records where it came from. Importers only read CC0
   sources, with the license evidence in their spec. Nothing goes in unless its origin can be
   shown to be CC0. (Replaces rmd's "upstream sources are origins".) The rest of rmd's
   principle II — timeouts, rate limits, `Retry-After`, explicit "unavailable" — still applies
   to importers.
2. **Every change is a recorded revision.** No write bypasses the revision log, imports and
   moderator fixes included. History is append-only; reverts are new revisions. The one
   exception is legal or abuse removal, which erases a revision's content but keeps the
   revision as a stub (§4.3).
3. **Contributors' work is never discarded.** Rejection returns work with a reason. Nothing a
   contributor submitted is hard-deleted, except for legal or abuse removal.
4. **One dataset, three views.** The browser, the API and the dumps serve the same data; a dump
   is a snapshot of what the API served.
5. **Privacy is tested from the outside** (rmd's principle I, adapted). Pending and rejected
   submissions (beyond the duplicate-check fields in §5.3), contributor emails and API usage
   each have a test that calls the API as someone who
   shouldn't see them and asserts the response (404, not 403, where existence would leak).

## 11. Left to the builder

- Table and column design, including how revisions, review units and current state are stored.
- Edition modeling for books (§4.2) and whether TV seasons/episodes are works.
- The final work-link and creator-role value lists.
- Bot and abuse protection for anonymous submissions.
- Whether v1 ships a bulk submission path (§5.2), provided the design doesn't preclude one.
- Dump format and hosting.
- How importers match records across Wikidata and Open Library, and how they handle later
  re-imports, including what happens when a re-import disagrees with a human edit.
- Whether v1 ships the corroboration rule (§6.1).
- Search implementation (rmd uses Postgres `tsvector`).
- Implementation order and the slicing into plans.

## Production Annotations

Shortcuts taken in plan 1 that would be wrong at scale (constitution, Standards). Each names what
fixes it.

**Rate limiting and abuse**

- The anonymous-submission limiter (`apps/api/src/platform/http/rate-limit.ts`) keeps its windows
  in process memory: limits reset on deploy and are per instance, so N replicas allow N times
  the limit. Better Auth's limiter (sign-in codes) is in memory too. Fix: a shared store
  (Postgres or Redis) before running more than one instance.
- The limiter keys on the client address in `X-Forwarded-For`, trusting the last
  `TRUSTED_PROXY_HOPS` entries (default 1, Railway's edge). If the proxy chain changes and the
  setting doesn't, the limit keys on the wrong entry (too low: spoofable; too high: every client
  shares a bucket). Requests without a trustworthy address share one bucket. Better Auth reads
  the address its own way; check it matches before relying on its limits.
- *No bot protection on anonymous writes.* Hold-all means spam reaches only the moderators'
  queue, and a per-address limit caps it. Add a challenge (e.g. Turnstile) if the queue fills.
- *Reads are public until plan 4.* Spec §7 wants an API key on reads. Plan 2 deploys reads
  without a key. Plan 4 adds keys and metering.

**Queries without the index they need**

- Search for non-work kinds and both duplicate-check queries (existing entities, and pending
  creates' `title_norm`) match a leading-wildcard `like '%…%'`, which no btree index serves. Fix:
  `pg_trgm` GIN indexes on the `*_norm` columns.
- Search orders by a `coalesce(...)` of the kinds' title columns, which no index covers.
- Missing indexes: `changes.entity_id`, a GIN index on `changes.depends_on`, `changes.relation_id`,
  `changes.resubmit_of`, an expression index on `changes.payload->>'revertOf'`,
  `submissions.author_user_id` and `submissions.anon_hash`. Every lookup on them is a scan.
- Redaction's scrub (`scrubRedacted`) scans every change on the entity's merge family and, for a
  relate, every merge change. The history query's recursive merge-family CTE runs per request.
- `resolveWinner` issues one query per merge hop.
- A merge locks every active relation of both entities; a heavily linked entity makes merges slow
  and contended.

**Schema and operations**

- `ADMIN_EMAILS` grants admin only when an account is created; adding an address later does
  nothing for an existing account.
- Demoting the last admin is refused (`last_admin`), but the check and the role change don't
  share a transaction, so two admins demoting themselves at once could still leave none;
  recovery then needs a database edit.
