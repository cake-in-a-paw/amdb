# Creator credits grouped by show: design

Status: approved by the owner, 2026-11-12. Builds on `2026-11-11-work-hierarchy-design.md`.

## Why

A creator's page lists their works, one row per credit (`relations.works`, built in
`features/catalog/service.ts` from every live `work_creator` relation, unbounded). The work
hierarchy made seasons and episodes works that can carry their own credits, and the Wikidata
`--parts` import (not yet run in production) will credit an episode's director (`P57`), writer
(`P58`), creator (`P170`), producer (`P162`), composer (`P86`) and studio (`P272`) when AMDB
already holds them.

Without a change, a director of 60 episodes gets 60 rows, and a TV studio that Wikidata names on
every episode of its shows gains thousands. Measured in production on 2026-11-12, before any parts
exist: the median creator has 1 work, 99% have at most 44, 206 have more than 100, and the largest
are film studios at 985 to 1,283 works, whose entity responses are about 200 to 260 KB and return
in 0.2 to 0.3 s. That is heavy but working; the parts import would multiply it.

The owner wants a creator's page to say **what shows they've worked on, in what roles**, and to be
able to **drill down to the episodes they worked on and in what role, one show at a time, not at a
glance**.

Success: after `--parts` runs, every creator's page has at most one row per show, and is about as
long as it is today, while every episode credit can still be found from that row.

## Goals

- A creator's works list has one row per **root work** (a work that is not a part): the root
  itself if they're credited on it, and any root that has a part they're credited on.
- Each row shows the roles gathered from every credit at or under that root, each role once.
- A row whose root has credited parts offers a way into a focused view of that one show.
- The focused view lists the parts of that show the creator is credited on, with their roles, in
  parts order, and is paged.
- This ships before the production `--parts` import runs; it is a gate on that import.

## Non-goals

- Paging the creator works list itself. After grouping it is as long as today, and today's largest
  pages work. Revisit separately if it becomes slow; the measurements above are the baseline.
- Any change to how credits are stored, imported or edited: one `work_creator` relation per credit
  stays the record, and the edit form is unchanged.
- Any change to a work's own page. Seasons and episodes keep listing their own creators.
- The "more by this creator" groups on a work page (`related.byCreator`). They already leave parts
  out (work hierarchy, Task 5).
- Music and games parts. The rule is written for any part, but only TV parts exist.

## Anti-goals

- Episode rows anywhere on a creator's page at a glance.
- Dropping or hiding a credit so it can't be reached: every live credit is reachable through the
  page and the API (constitution IV, V).
- A creator's page that loads every one of a studio's episode credits to build its rows.

## Decided

- **Grouping key is the root work.** A part's root is the top of its live `work_part` chain
  (episode → season → show, or episode → show). A part whose chain is broken (an orphan part, or
  a part under a removed show) is its own row, so its credit never disappears. *Cost if wrong:*
  an orphan episode shows as a row of its own until someone attaches it.
- **One row per root for every work, films included** (my call). A creator who directed and wrote
  a film gets one row, "director, writer", instead of two. That keeps films and shows the same
  shape. *Cost if wrong:* the list reads differently for films than today; easy to split back.
- **Which credits count** (my call): exactly the credits a creator page lists today, meaning
  live `work_creator` relations to listed works (not removed, retracted or merged away).
  - A root row exists when at least one such credit sits at or under it.
  - A root that isn't listed itself (a removed show) but has credited listed parts still gets its
    row, marked removed and shown with the existing "a removed work" copy, so the credits stay
    reachable.
  - An orphan part is a root of its own, as above.
- **Roles** (my call):
  - Distinct per row, in the `@amdb/shared` role-list order. Any role string outside that list
    comes after, alphabetically.
  - Every `work_creator` relation carries a role (`relations_type_columns`), so a row's `roles`
    is never empty.
- **Row content** (my call): the root's title and year, as today, then its roles. When the
  creator has credits on its parts, a count follows, such as "12 episodes" or "2 seasons, 14
  episodes", which is the way into the focused view. A row for a root with no credited parts
  looks like today's row.
- **List order** (my call): today the list follows credit creation order (`created_at`, then
  `id`). A grouped row takes the place of its earliest credit, so a page with no part credits
  keeps today's order. Credit `position` isn't shown on creator pages today and doesn't enter
  the order.
- **The focused view shows one show at a time** on its own page, a route under the creator.
  - It is headed by the creator and the show.
  - Each credited work is listed with its label and title (the existing `partLabel`/`partTitle`,
    e.g. "S2E3 · Pilot") and the creator's roles on it.
  - The order is one flat list: a credit on the show itself first, then the credited parts in the
    work hierarchy's parts order, walked depth-first. Each season the creator is credited on comes
    directly before its credited episodes. Episodes under a season they aren't credited on are
    still listed, with no row for that season, and episodes directly under the show follow the
    seasons.
  - It uses cursor paging like `/api/entities/{id}/parts`.
- **API** (my call on the field names):
  - The creator entity view gets `relations.credits` in place of `relations.works`. Series,
    property and tag pages keep `relations.works` as it is.
  - Each `credits` entry is `{ work: Summary, roles: string[], parts: Record<Subtype, number> }`.
    `parts` maps each part subtype under that root to how many of them the creator is credited
    on, and is empty when there are none.
  - The web's `list-page` gets a creator branch that reads `credits`. Regenerate the OpenAPI
    snapshot and client types.
  - A new paged endpoint returns one creator's credits at or under one root work, in the focused
    view's order. Each item has the credited work's summary, including its `part` label data, and
    the creator's roles on it. Unknown or merged ids behave like the parts endpoint (404, 410,
    redirect).
- **Built in SQL, bounded.** Grouping and counting happen in the database, so building a studio's
  page never reads its part credits one by one. TV trees are at most two levels deep under a show.

## Constraints

- Constitution v0.2.0 binds: VI (tests over HTTP on PGlite), VIII (repository holds the queries,
  service the rules), IX, XI (loading, error and empty states for the focused view), XIII.
- No schema change is expected. If an index is needed for the grouping query, it is a new
  migration.
- A creator page response for a studio after `--parts` stays about the size it is today.

## Left to the builder

- The focused view's URL and the new endpoint's path and page size.
- Whether the root is resolved per query or through a helper shared with the existing `ancestry`
  walk, and what index, if any, the grouping needs.
- How a removed or merged-away root is shown (follow the work hierarchy's existing "a removed
  work" copy).
- Whether roles are deduplicated and sorted in SQL or in the service.

## Production Annotations

- The focused view orders one creator's credits under one show in the service, after reading all
  of them, because the depth-first parts order spans two tree levels. That's bounded by one show's
  size: at most a few thousand rows for the longest-running shows. If a show ever holds far more,
  move the order into SQL.
