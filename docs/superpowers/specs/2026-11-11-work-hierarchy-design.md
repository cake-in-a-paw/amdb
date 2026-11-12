# Work hierarchy (seasons, episodes, tracks): design

Status: approved, 2026-11-12. The owner answered the open questions on
2026-11-11 (see Decided).

## Why

AMDB holds a TV show as one work. Nothing below it can be named, linked or corrected: not
*Breaking Bad*'s second season, not "Ozymandias", not its director or air date. Developers who
build on AMDB (rmd first among them) need to point at a season or an episode, and Wikidata already
has most of them: on 2026-11-11 the query service counted 27,058 items that are a television
series season (Q3464665) and 183,964 that are a television series episode (Q21191270).

Music has the same shape: an album holds tracks. Games will too, once AMDB has games: a base game
has expansions and DLC. The owner asked for one model that covers all three, the same one rmd uses
for TV.

Success: a show, each of its seasons and each episode are works with their own ids, pages,
history and credits; each knows its place (show › season 2 › episode 14); contributors can add
and fix them through the normal submission flow; and adding albums and tracks, or games and their
expansions, is new rows in a value list, not a new model.

## Goals

- **Parts are works.** A season, an episode or a track is a `work` like any other, with its own
  id, fields, creators, external ids, history and page. This settles design spec §11 ("whether TV
  seasons/episodes are works") and §4.1 ("a show's seasons if modeled as works"): they are works,
  and they are not `series` entities.
- **A work may have one parent work**, with an optional number (season 2, episode 14, track 3).
  A work with no parent is a **root**. TV is show → season → episode, or show → episode for a
  show without seasons.
- Contributors can create parts, attach a work to a parent, move it, renumber it and detach it,
  through submissions and review. Every one of those is a revision and can be reverted
  (constitution III).
- The Wikidata importer brings in every season and episode Wikidata has for the shows AMDB holds.
- A work's page, its API response and the dumps show its parent chain and its parts.
- The value list of which subtypes may be parts of which (`@amdb/shared`) is the only thing a new
  medium adds: albums and tracks for music, expansions and DLC for games.

## Non-goals

- **Music and games importers, creator roles and pages.** Music doesn't ship in this release (the
  owner's call). The model must take music and games without a redesign, and their importers,
  roles and pages are their own specs.
- **Per-episode tracking, watch status or ratings.** AMDB has no library; that is rmd's concern.
- **A work with several parents** (a recording on many albums, a game in a bundle, an episode in
  two cuts of a show). Single parent only; for music, a track is one recording per album
  position.
- **Grouping existing separate works under a new parent** in bulk (for example anime seasons that
  Wikidata holds as separate `anime_series` items). Contributors can do it one by one; no
  importer does it.
- **Art for parts.** A season or episode shows no linked art of its own yet; the artwork spec
  would need amending first.
- **Overall episode numbers** ("episode 47 of the series"). They follow from the order and aren't
  stored.
- **Importing anything from TMDB.** TMDB's terms aren't CC0, so constitution II rules it out as a
  source. Its season and episode ids, as Wikidata holds them, are CC0 facts and may be stored.

## Anti-goals

- **An import that floods the catalog.** Episodes titled "Pilot" crowding out the film *Pilot* in
  search, or a show's 60 episodes filling every "same creator" list, would be a failure even if
  each row were correct.
- **Children without their parents.** An import run that stops at the size cap and leaves
  thousands of episodes whose show isn't in AMDB.
- **Silent loss in a merge.** A merge that quietly drops a part's parent, or its number, without
  the drop being in the merge's revision and undone by its unmerge.
- **Copied fields that go stale.** rmd copies the show's title into each season and episode; in
  AMDB every such copy would be a field that needs its own revisions and goes stale when the show
  is renamed.
- **Bogus sequel links.** Wikidata episodes carry P155 "follows"; the current importer maps P155 to
  `sequel_of`, which would add ~180,000 links from each episode to the one before it.

## Constraints

- Constitution 0.2.0 (`CLAUDE.md`) binds, in particular:
  - every catalog write goes through `features/changes/apply.ts` (VIII), and every change is a
    revision, including imports (III);
  - nothing a contributor submitted is hard-deleted (IV);
  - API, browser and dumps serve one dataset (V);
  - value lists live once in `@amdb/shared` as `text`, never as Postgres enums (IX, X);
  - rules that span rows are enforced by the service under a lock, rules within a row are
    `CHECK`s, and uniqueness that matters is a unique index whose violation becomes a 409 (X);
  - applied migrations are never edited (X), and the OpenAPI snapshot is regenerated (IX).
- **CC0 sources only** (II). For TV that means Wikidata. TMDB and AniList (rmd's sources) are out.
- **Size.** On 2026-11-11 the database is about 1.44 GB of the 3.5 GB import cap, holding about
  173,000 works and 100,000 creators with their history: roughly 5 KB per entity. The owner
  chose every season and episode Wikidata has (up to about 27,000 seasons and 184,000 episodes),
  so at a similar per-work cost the import could add about 1 GB, taking the database to about
  2.5 GB. That's under the cap, with little room left for other growth. Before any production import,
  a dry run reports counts (per class, placement, skipped credits), and a real run into a local
  database measures bytes per part. The import stops at the size cap
  like other runs, and only between seasons (see Anti-goals). If the projection passes the cap,
  the deploy runbook's step applies: upgrade the Railway plan and grow the volume first.
- Production imports need the owner's go-ahead at that moment, run alone, and never overlap a
  deploy.

### The reference: rmd's model

rmd (`apps/api/drizzle/0016_catalogue_tree.sql`, films and TV spec §4, §5, §7) stores the tree on
the item row:

- `catalogue_items.parent_id` (a season's show, an episode's season) and `root_id` (the show, for
  both), each a self-FK, indexed.
- Two kinds of child, as subtypes: `season` and `episode`. A `CHECK` ties having a parent to being
  one of them, and another ties `parent_id` to `root_id`. That a season's parent is a `series` and
  an episode's parent is a `season` (and its root that season's show) spans rows, so the service
  checks it on write. Depth is fixed at three.
- Numbers live in `attributes` (`season_number`, `episode_number`), with `show_title` copied in so
  a card can say "Severance · S2E7" without a join. Children are listed by those numbers, season 0
  ("Specials") last.
- Children carry their own title, date, description and runtime, and no tags; tags, the library
  and where-to-watch reach the show through `root_id`. Search lists roots only.
- Nodes are filled on demand from TMDB (a show's call creates its seasons, a season's call its
  episodes), keyed by source ids like `tv:<id>:s<n>:e<m>`. AniList's anime seasons stay separate
  flat items. Games are base games only.
- A recommendation may point at any node; the library holds only roots.

### What Wikidata offers

Checked against live items on 2026-11-11 (*Breaking Bad* Q1079, its season 1 Q1582890, "Pilot"
Q14625947, "Cat's in the Bag..." Q13456973, *Abbey Road* Q173643, "Come Together" Q60711674) and
by count queries on the query service.

| What | How Wikidata says it |
|---|---|
| A season | `P31` Q3464665 *television series season*; `P179` *part of the series* → the show, qualified `P1545` *series ordinal* = season number; `P1113` episode count; `P580` start date. The show lists its seasons back under `P527` *has part(s)* with `P1545`. |
| An episode | `P31` Q21191270 *television series episode*; `P4908` *season* → the season, qualified `P1545` = number within the season; `P179` → the show, qualified `P1545` = **overall** number; `P155`/`P156` previous and next episode; its own `P57` director, `P58` writer, `P577` date, `P2047` duration, `P345` IMDb id. The season lists episodes back under `P527` with `P1545`. |
| Counts | 27,058 seasons; 183,964 episodes, of which 171,077 have `P4908` and 521 have no `P179`. 24 items are both a season and a TV series; 54 are both an episode and a film. |
| TV ids | `P12558` TMDB season ID and `P12559` TMDB episode ID exist (CC0 identifiers; not checked how often they're filled). |
| An album | `P31` Q482994 *album* (a release group); `P658` *tracklist* → track items, qualified `P1545` position and `P2047` duration. 311,056 albums; only 12,201 have a tracklist. |
| A track | e.g. Q55850593 *music track with vocals*, or Q7302866 *audio track*; `P175` performer; `P2550` *recording or performance of* → the song (Q7366); `P1433` *published in* → **every** release it appears on ("Come Together" lists five). |
| Games | `P8646` *expansion of* → the base game (7,411 statements, video and board games); classes Q209163 *expansion add-on* (4,370 items) and Q1066707 *downloadable content* (2,710). |

Two things follow. TV in Wikidata is a strict tree with numbers, close to rmd's. Music is not: a
track item is a recording that Wikidata places on many releases, and few albums list tracks at
all. MusicBrainz is the richer music source, and its core data is CC0
(https://musicbrainz.org/doc/About/Data_License, checked 2026-11-11), but it is a new importer
with its own spec. Whether Wikidata's per-season `P1545` values are reliable at scale is a guess
from two shows, not a measurement.

## Decided

By the owner:

- TV shows get seasons and episodes, with the same data model as rmd.
- The model also applies to music (albums and tracks).
- It may later apply to games (expansions and DLC), and must not block that.
- **The first release ships TV only.** Music comes later, under its own spec.
- **The import brings in every season and every episode Wikidata has** for the shows AMDB holds,
  not only well-known shows' episodes.
- **When music ships, MusicBrainz (CC0 core data) is its source**, with its own importer spec.
- **A track is one recording per album position**, so every part keeps one parent. Linking
  positions that are the same recording is later work, if it's wanted.
- **Seasons and episodes stay out of default search and browse.** They appear on their show's
  page, and a filter includes them in search.
- **Game expansions and DLC will be parts under their game**, the same model as seasons. A
  standalone expansion can still be its own work.
- **The parts import credits only creators AMDB already holds.** A season's or episode's director,
  writer or other credit whose Wikidata item isn't a live AMDB creator is skipped and counted
  (`creditsSkipped`), never created. This keeps the size projection to the parts themselves and
  keeps episode-only people out of creator search. A later backfill can add them if the owner
  wants them.

By me, after the builder check (each with what it costs if wrong):

- **Where an episode hangs.** In order:
  1. **Under its P4908 season,** when that season is under the same show and is imported.
  2. **Under a season of the same show whose P527 lists it,** when step 1 doesn't apply.
  3. **Directly under the show, numbered by its overall order,** when the show has no seasons at
     all.
  4. **Otherwise skipped and counted** (`partsUnplaced`), never guessed.

  An episode whose P4908 season belongs to another show is unplaced. *Cost if wrong:* some
  episodes Wikidata half-describes are missing until Wikidata or a person fixes them; none is
  filed in the wrong season.
- **The parts import is its own importer mode** (for example `--parts`), and it can be re-run:
  a re-run adds seasons and episodes Wikidata has gained since, under the same never-overwrite
  and stays-reverted rules as the backfill. Ordinary import runs don't fetch parts. The size cap
  check runs between seasons in this mode. *Cost if wrong:* a show imported later gets its
  episodes only when someone runs the parts mode again.
- **Seasons and episodes include Wikidata's subclasses** (`P31/P279*` of Q3464665 and Q21191270),
  such as anime episodes, because the owner asked for everything available. The dry run reports
  how many come from subclasses. If the class query times out, the builder splits it per show or
  per subclass. *Cost if wrong:* a subclass that isn't really a season or an episode gets
  imported; the dry run's per-class counts are where to catch that.

By me (each with what it costs if wrong):

- **Same shape as rmd, stored as a relation instead of a column.** The tree is rmd's: works with
  one parent, kinds of part as subtypes, a number per part, and every node addressable. The parent
  link is a new relation type, `work_part`, from the parent to the child, with `position` as its
  number, modeled on `series_work`. A `parent_id` column, as in rmd, would need new code in every
  path AMDB already has for relations: a merge repoints relations but not columns, so a merged-away
  show would keep its children; `retract_entity` refuses (`has_dependents`) only on live
  relations; `relate`/`unrelate` give provenance (`created_by_change`, `removed_by_change`) and
  revert for free; history and the entity view already list relations. *Cost if wrong:* finding
  a part's parent is a join instead of a column read, and the root needs up to two joins. If that
  proves slow at scale, a derived column can be added later without changing the API.
- **No `root_id`, and nothing copied from the parent.** The root and the parent chain are
  computed at read time (at most two levels up today). rmd copies `show_title` into `attributes`;
  here that copy would be a field needing its own revisions whenever the show is renamed. *Cost if
  wrong:* list views that show context ("Breaking Bad · S1E1") do a join per page, which an index on
  the child end serves.
- **One parent per child, guarded by the database.** A partial unique index on the child end of
  live `work_part` rows; a second parent is a 409. There is **no** unique index on
  (parent, position): two "Season 1"s under one show are a duplicate for people to merge, not a
  write error, and merging two shows would otherwise fail. *Cost if wrong:* a work truly in two
  places (a recording on two albums) can't be modeled; the owner chose one recording per album
  position for music.
- **A part without a parent is allowed.** In AMDB the create and the relate are separate changes,
  either can be rejected or reverted, and a contributor may add an episode before its season
  exists. So, unlike rmd's `CHECK`, being a `season` doesn't require a parent row. *Cost if wrong:*
  orphaned seasons can exist; the importer never creates one (it writes the part and its
  `work_part` in one submission), and the browser labels one "not attached to a show".
- **Which subtypes may be parts of which is one value list in `@amdb/shared`**, checked in
  `apply.ts` under the parent's lock when a `work_part` is related, when either end's subtype or
  media type is updated, and when a merge would repoint one. Today:
  - `film_tv`: `season` under `series` or `anime_series`; `episode` under `season`, `series` or
    `anime_series`.
  - `music`, if it ships: `track` under `album`, `single` or `ep`.
  - `video_game`, later: `expansion` and `dlc` under `game`; `dlc` under `expansion`.

  A part has the same media type as its parent. Root subtypes (`movie`, `series`, `album`, `game`,
  …) never have a parent. Because the list points only downward, a cycle is impossible as long as
  subtype changes are re-checked, so no cycle query is needed, and depth follows from the list
  (three levels today). *Cost if wrong:* a fourth level, or a part with no subtype of its own,
  needs only a new row in the list, not a migration.
- **`Subtype` gains `season` and `episode`** (new values in the existing value list). The
  `works_subtype` `CHECK` (subtype iff `film_tv`) is replaced in a new migration when a second
  medium needs subtypes.
- **Music, when it ships, is a new media type `music`**, with subtypes `album`, `single`, `ep`
  and `track`, not rmd's `music_album`, because a track isn't an album. It gets its own attributes
  schema and creator roles (performer, composer, lyricist, producer at least). *Cost if wrong:*
  renaming a media type after data exists is a migration and a breaking OpenAPI change, so this
  name is worth the owner's glance even though music doesn't ship in this release.
- **The number is `work_part.position`, optional, and may be 0.** It's the season number, the
  episode's number within its season (or within the show when there are no seasons), or the track
  number. Season 0 and episode 0 are valid (specials, prologues). Parts are listed by position,
  with no-position parts after numbered ones, then by release date, then by title; a season
  numbered 0 is listed last, as rmd does. A part without a whole-number position (games DLC, an
  ordinal like "1a") simply has none. *Cost if wrong:* display labels like "12a" or "1–2" can't be
  shown; a text label can be added to the relation later.
- **Which Wikidata ordinal is the number:** a season's number is its `P179` → show `P1545`, else
  the show's `P527` qualifier; an episode's is its `P4908` → season `P1545`, else the season's
  `P527` qualifier; an episode with no season hangs from the show with its `P179` `P1545`. When
  the child's own statement and the parent's list disagree, the child's wins; when a value isn't
  a whole number, the part gets no position. *Cost if wrong:* some numbers are off by Wikidata's
  own inconsistency, which contributors fix like any field.
- **Each part carries its own fields and nothing is inherited into storage.** Title, release date,
  lifecycle, description, runtime, its own creators (an episode's director and writer) and external
  ids (IMDb `tt…`, and new id schemes `tmdb_season` and `tmdb_episode` from `P12558`/`P12559`).
  Responses show the parent chain so clients can show the show's tags and credits alongside.
  *Cost if wrong:* clients that want "the genres of this episode" must read the root.
- **Series and property memberships belong to roots.** `series_work` and `property_work` to a
  part are refused (`invalid_relation`); tags and work links are allowed on parts, but the importer
  adds neither. *Cost if wrong:* an anthology season can't sit in a series of its own until the
  rule is relaxed.
- **Merges:** the existing merge repoints `work_part` like any relation, with these additions,
  each undone exactly by the merge's `unmerge`:
  - The winner keeps its parts and gains the loser's (merging two copies of a show gathers both
    sets of seasons; duplicate seasons are then merged, which gathers their episodes).
  - If both have the same parent, the loser's link is dropped as a duplicate (the existing rule,
    which ignores position).
  - If they have **different** parents, the merge is refused with 409 `conflicting_parents`, never
    a 500 from the unique index. The fix is to merge the parents first, or detach one. Merging
    top-down, show then season then episode, never hits this.
  - A merge whose result breaks the subtype list (merging a season into a film that has no place
    for its episodes) is refused with 409 `invalid_tree`.
- **Retraction and rejection need no new rule.** Rejecting a pending show create already rejects
  the `work_part` relates that depend on it. The pending part creates stay pending as parts
  without a parent, which are allowed, for a moderator to review on their own. Reverting a show's create already fails with
  `has_dependents` while live `work_part` links to it exist, so a show's parts are reverted first.
- **Legal or abuse removal doesn't cascade.** Removing a show leaves its seasons and episodes in
  place, since each removal is its own decision. Their pages still resolve and say they belong to
  a removed work; they are never listed as roots.
- **The import follows the tree; it doesn't rank parts.** Parts are fetched per show AMDB already
  holds (seasons with `P179` → the show, episodes with `P179` → the show), never ranked by sitelinks
  on their own, so a capped run never leaves episodes without their show. One submission per
  season, holding the season, its episodes and their `work_part` links, so a bad episode blocks
  one season, not a show of 30. For parts, `P155`/`P156` aren't mapped to `sequel_of`, and `P179`
  gives the parent, not a series membership. Running this needs a new importer mode, because the
  current `--backfill` creates no works. The importer spec is amended to say so.
- **Every view:** `work_part` is a value of `RelationType`, so it appears in history, in the
  OpenAPI document (regenerated), and in the dumps when they are built, as any relation will
  (constitution V). A work's
  entity view gains `parent` (relation id, work summary, position) and `ancestors` (root first),
  and its parts come from a paged endpoint, so a show of 1,000 episodes never makes an unbounded
  response.

- **Follow-up documents.** Relation-not-column gets an ADR, recording the `parent_id` column as
  the rejected option. Design spec §4.1 and §11 are amended to say seasons, episodes and tracks are
  works under a parent, and the importer spec is amended for the new mode.

## Open questions for the owner

None. The owner answered all six on 2026-11-11; the answers are under Decided.

## Left to the builder

- The migration: the `work_part` arm of `relations_type_columns` (`to_id` required, `position`
  optional), the partial unique index on the child end of live `work_part` rows, an index serving
  "parts of X in order". The `works_subtype` change waits for music.
- Whether the relate payload's `position` minimum moves to 0 for `work_part` only, or for every type
  (today it's at least 1).
- How `apply.ts` locks parent and child so a concurrent subtype update or second relate can't slip
  past the subtype check.
- The paged parts endpoint's path and page size, and keeping parts out of the unbounded relation
  load in `getEntity`.
- Keeping "related works" (same creator) from filling with one show's episodes, for example by
  leaving out parts of the same root.
- The duplicate check for a part: match among its prospective siblings, since "Pilot" isn't a
  duplicate of another show's "Pilot".
- Wikidata items already in AMDB as a `movie` or `series` that Wikidata also calls an episode or a
  season: skip them and count them (`partsHeldAsRoot`); never change a person's subtype.
- Stats names (`partsAdded`, `partsSkipped`, …) in `docs/import.md`, and the bytes per part
  measured by a local run.
- The search filter's name and shape for including parts (the owner decided parts are out by
  default).
- Re-runs for parts: a reverted season or episode stays reverted, and a season someone entered by
  hand under the show is adopted, not duplicated (matched by subtype and number under the same
  show, then by title).
- How the browser shows context on cards ("Breaking Bad · S1E1 · Pilot"), breadcrumbs, and an
  orphaned part.

## Review focus

- Storage: is a `work_part` relation acceptable as "the same data model as rmd"? It keeps rmd's
  tree and numbering but not its columns, its `root_id` or its copied show title.
- Merge two copies of a show, then their two "Season 1"s: every episode ends up under one season,
  and unmerging each step restores the tree exactly.
- Merge two episodes under different seasons: refused with 409 `conflicting_parents`, never 500.
- Change a season's subtype to `movie` while it has episodes, or change an episode's media type:
  refused.
- Relate a second parent to an episode: 409.
- Revert a show's import: fails with `has_dependents` until its parts are reverted; reject a
  pending show create: its pending `work_part` links are rejected with it, and its pending part
  creates stay pending without a parent.
- Import a show whose episodes carry `P155`: no `sequel_of` links appear between episodes.
- Import with a low `--max-db-bytes`: the run stops between seasons, and no episode exists without
  its season and show.
- The sibling duplicate check reveals for a pending part only its title, media type and year,
  never which parent it sits under (constitution I).
- A show with season 0: listed after the numbered seasons; an episode numbered 0 listed first.
