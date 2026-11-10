# Artwork — Design

**Status:** draft for owner review, 2026-11-07.
**Amends:** `2026-11-02-amdb-design.md` §4.4 (images) and §10 (constitution principle II);
`2026-11-05-wikidata-importer-design.md` (what it reads, backfill).

## Intent

Work pages look bare without posters and covers, and almost all cover art is copyrighted,
so AMDB can't host it under its CC0 rule (§4.4). The IDs that point at sites with art are Wikidata
statements, so they are CC0 and AMDB can hold them like any other external id. AMDB stores those IDs
and, when a page is shown, links the image live from the site that has it, with credit. AMDB never
stores the image or anything about it.

## Decisions (owner, 2026-11-07)

- Store IDs for sites that have art, and show their art by linking to it.
- **TMDB is the preferred source** for film, TV and anime. **Open Library** covers books, using the
  `openlibrary` id AMDB already stores. **AniList** is used only when no other source has an image.
- Amend constitution principle II to allow this (below).

## Goals

- A work's page shows its poster or cover, with a credit line naming the source and linking to the
  work's page there.
- Art shows only on a work's own page, never in a list: no thumbnails in search results, browse,
  list pages or related-works rows (owner, 2026-11-08).
- A work with no art, or whose source is unreachable, shows a neutral placeholder of the same size
  on its page, and nothing errors.
- The ~6,000 works already imported get the new IDs without being re-imported.

## Non-goals

- Uploading art, choosing between images, or moderating images.
- Art for creators, series or properties (only works).
- Hosting, resizing or proxying image bytes.
- Any data from TMDB or AniList other than the image URL needed to show the picture: no titles,
  ratings, overviews or other metadata.

## Anti-goals

- **Art in the dataset.** An image URL, a poster path or any other non-CC0 value in the database,
  the revision log, the API's entity reads or the dumps. Only the IDs are data.
- A page that breaks, hangs or shows an error because an art source is down or slow.
- Hammering a source: no bulk crawling, no prefetching art for works nobody is viewing.

## Constitution amendment (principle II)

Add to II, "Everything Is CC0":

> - Third-party art may be shown by linking live to its source, with credit. AMDB never stores,
>   imports or exports it, and it isn't part of the dataset (V). Only the identifier that locates
>   it is data.

This is a new rule inside a principle, so the version goes from 0.1.0 to 0.2.0 (MINOR). It needs an
ADR: `docs/decisions/0006-third-party-art.md`, from the template. The ADR records the decision, the
licensing reasoning (the IDs are CC0, the images are not and are never copied), the TMDB
non-commercial condition (below), and the rejected options: no art at all, or hosting only CC0 or
public-domain images, which is §4.4's v1 rule and leaves almost every modern work bare.

Spec §4.4 gets an amendment note pointing here: AMDB still *hosts* only CC0 or public-domain images.
Linked third-party art follows this document.

## Sources and terms

Checked 2026-11-07. The ADR quotes these.

| Source | Terms | What matters for AMDB |
|---|---|---|
| TMDB | https://www.themoviedb.org/api-terms-of-use | Free for non-commercial use only. §2.A: commercial use, including using TMDB content to drive revenue for a website, needs a written agreement. Must show the TMDB logo, less prominent than AMDB's own marks, and the notice "This product uses the TMDB API but is not endorsed or certified by TMDB." Must not cache TMDB information for more than 6 months. Must not be used as an image host for unrelated graphics. |
| Open Library | https://openlibrary.org/dev/docs/api/covers | Use `covers.openlibrary.org` URLs as the `src` on public pages. Don't crawl or bulk-download. A courtesy link back is appreciated. Lookups by OLID or cover id are not rate-limited; lookups by ISBN are (100 per IP per 5 minutes), so AMDB doesn't use ISBN lookups. |
| AniList | https://docs.anilist.co/guide/terms-of-use | Free, including commercial use under $150 a month. Not for competing list or tracker services; AMDB is a catalog, not a tracker. 30 requests a minute while AniList is degraded (normally 90). No storage or hoarding. |

**Non-commercial condition (owner, take note):** AMDB earns nothing today, so TMDB's free terms fit.
Spec §7 plans paid credits later. Before any paid access ships, re-check TMDB's terms; it may need a
commercial agreement or switching TMDB art off. The art endpoint is unmetered and never costs
credits, but TMDB judges the site as a whole.

## New external ids

| Wikidata | Format (Wikidata P1793) | AMDB `IdScheme` |
|---|---|---|
| P4947 TMDB movie ID | `[1-9]\d{0,7}` | `tmdb_movie` |
| P4983 TMDB TV series ID | `[1-9]\d*` | `tmdb_tv` |
| P8729 AniList anime ID | `[1-9]\d*` | `anilist` |

- TMDB numbers movies and TV separately: movie 1 and TV 1 are different titles. The uniqueness index
  is on (scheme, value), so the two need separate schemes.
- They are added to `IdScheme` in `packages/shared/src/values.ts`. `scheme` is a text column, so no
  migration is needed. The web form's scheme picker gets them automatically.
- The importer maps them like `imdb`: the value must match the format, otherwise it is dropped. This
  goes into the importer spec's mapping table. The license evidence is unchanged: these are
  main-namespace statements.
- An imported work whose new id is already held by another work keeps the importer's existing rule:
  the work goes in, and its clashing ids are dropped.

## Getting the IDs onto existing works

The backfill (`--backfill`) currently never touches external ids. It is extended to add them, with
the same guarantees as for references:

- It adds a work's external id for a scheme the importer maps when the work has **no** `external_id`
  row of that scheme, live or removed. A removal sticks, and an id a person corrected is never
  overwritten or duplicated.
- It skips an id whose (scheme, value) another live entity already holds, and counts it in a new
  stat, `idsSkippedHeld`. A clash never fails the work's submission.
- New stat: `idsAdded`. The work's single backfill submission carries its new ids alongside its
  missing references, so a work with either counts as `backfilled`.
- This applies to every mapped scheme, not just the new ones. That also restores IMDb and Open
  Library ids the duplicate-id retry dropped, when they no longer clash.

Production run (owner approves at the time): `--backfill --limit 2000` per class (films, TV series,
books; anime classes if any were imported), one after another.

## Showing the art

### API

One public endpoint, used by the work page (one id); API callers may ask for a batch:

`GET /api/art?works=<id>,<id>,…` (at most 50 ids; more is a 400 in the standard error shape)

```json
{ "items": {
    "<workId>": { "status": "found", "source": "tmdb",
                  "thumb": "https://image.tmdb.org/t/p/w154/abc.jpg",
                  "full":  "https://image.tmdb.org/t/p/w500/abc.jpg",
                  "link":  "https://www.themoviedb.org/movie/603" },
    "<workId>": { "status": "none" },
    "<workId>": { "status": "unavailable" } } }
```

- `none`: no source has art for this work. `unavailable`: a source failed or timed out (II: say
  "unavailable", never pretend "no art"). An unknown, removed or non-work id is `none`, so the
  endpoint doesn't reveal anything entity reads don't already show. A merged work resolves to its
  winner.
- Unmetered and free, for the browser and API callers alike. It is a display aid, not dataset data,
  so it isn't in the OpenAPI entity schemas or the dumps. It is in the OpenAPI document as its own
  operation, and the snapshot is regenerated, not hand-edited.
- Lives in a new feature folder, `apps/api/src/features/art/` (routes, service, repository, VIII).
  The repository reads a work's live external ids. The service holds the source clients and cache.

### Resolving a work's art

Each source is tried in this fixed order, for whichever ids the work holds:

1. `tmdb_movie`, then `tmdb_tv`: TMDB `GET /3/movie/{id}` or `/3/tv/{id}`, reading `poster_path`.
   Image URLs are built from TMDB's image base (`https://image.tmdb.org/t/p/`) with sizes `w154`
   (thumb) and `w500` (full).
2. `openlibrary`: an edition id (`OL…M`) gives `https://covers.openlibrary.org/b/olid/{id}-{M|L}.jpg`.
   AMDB first checks the cover exists with `?default=false`, which returns 404 when there is no
   cover. A work id (`OL…W`) gives `https://openlibrary.org/works/{id}.json`, whose first `covers`
   entry yields `https://covers.openlibrary.org/b/id/{coverId}-{M|L}.jpg`. Thumb is `M`, full is `L`.
3. `anilist`: a GraphQL `Media(id, type: ANIME) { coverImage { medium large } }` query to
   `https://graphql.anilist.co`.

- The first `found` wins. A source moves on to the next only on a definite **none** (no poster, or a
  404). If a source is **unavailable**, resolution stops and the work is `unavailable`. Otherwise an
  outage at TMDB would silently swap in AniList art. *(My call.)*
- A work with no art ids at all is `none` without any outbound call.

### Being a good client

Each source gets the same treatment as the importer (II): a timeout (3 s per call), its own rate
limit (TMDB 20/s, Open Library 5/s, AniList 20/min, under AniList's degraded 30/min), honoring
`Retry-After` by reporting `unavailable` until it passes, and the importer's User-Agent
(`AMDB-importer/0.1 (https://github.com/cake-in-a-paw/amdb)`, or an `AMDB/0.1` form of it).
- A call waits for room under its source's limit, but only within the request's overall 3-second
  deadline. Ids still waiting when the deadline passes are `unavailable`, and the work page asks
  once more (below). *(My call.)*
- `/api/art` has a per-IP limit, using the existing `rateLimit` middleware (a 429 in the standard
  error shape, listed in the OpenAPI operation). This stops one client from using up a source's limit
  for everyone. "Unmetered" means it costs no credits, not that it is unlimited. *(My call.)*

### Cache

- An in-process cache keyed by (source, scheme, id): `found` for 7 days, `none` for 1 day.
  `unavailable` is never cached. Bounded in size (on the order of 20,000 entries). The resolved
  answer per work is cached too, so a batched request costs at most one outbound call per uncached source
  id.
- This is a cache, not storage. It lives in memory, empties on deploy and stays far inside TMDB's
  6-month limit. Being per instance, it's listed under Production Annotations below.
- Whether to use an existing LRU dependency or a small map is the builder's call (XII: check first,
  and name any new dependency in the plan).

### Configuration

- `TMDB_API_KEY` (a v3 API key, kept as a secret, never logged) is optional, so the app starts and
  deploys without it. When it's unset, every TMDB lookup is `unavailable`, never `none`, so AniList
  never stands in for missing TMDB art, and the API logs one warning at startup. Films and TV show
  placeholders until the key is set. The owner creates the TMDB account and key and sets it on
  Railway; Claude doesn't. *(My call: a required key would take production down if this shipped
  first.)*
- AniList and Open Library need no key.

### Web

- **Work page** (`entity-header`): the full image at a fixed aspect ratio (2:3), with a credit line
  under it, "Poster: TMDB", "Cover: Open Library" or "Cover: AniList", linking to `link`.
  `loading="lazy"`, `alt` is "Poster for {title}" or "Cover for {title}", and the fallback is the
  placeholder.
- **Lists** (search, browse, list pages, related works, home): no art, and no art requests, so rows
  keep their plain look (owner, 2026-11-08). Art shows only on a work's own page.
- **Retry:** if the work page's answer is `unavailable`, it asks once more about 5 seconds later.
  After that the placeholder stays; a later visit asks afresh, since an `unavailable` answer is not
  reused.
- **Placeholder:** the title set on a neutral box in the theme's muted color. It is used
  for `none`, `unavailable` and while loading. A broken image (`onerror`) also falls back to it.
- **Attribution:** the footer (`app-shell`) gets the TMDB logo, smaller than AMDB's mark, with
  TMDB's notice, and "Covers from Open Library and AniList" linking to each. It is always shown.
- Images load straight from the source's domain. The browser never fetches art through AMDB.

## Tests (VI: PGlite, only the sources faked)

- Resolution order: TMDB beats AniList; a TMDB `none` falls through to AniList; a TMDB failure gives
  `unavailable`, not AniList; a book uses Open Library edition and work ids; no ids gives `none` with
  no outbound call.
- Timeouts and `Retry-After` give `unavailable`. A call under a full limit waits, and still gives
  `unavailable` when the 3-second deadline passes. With no TMDB key, a film with TMDB and AniList ids
  is `unavailable`. The per-IP limit returns 429. A 50-id request
  succeeds, and 51 ids is a 400.
- An unknown, removed or non-work id gives `none`. A merged work gives its winner's art.
- Cache: a second request makes no outbound call; `unavailable` is retried.
- Nothing from a source is written to the database. Assert the tables are unchanged after art
  requests.
- Importer: the three new properties map, invalid formats are dropped, and a clash keeps the work.
- Backfill: adds missing ids; skips a scheme with a removed id; skips and counts an id held
  elsewhere; a second run adds nothing.
- Web: the placeholder shows for `none` and `unavailable` and on an image error; `unavailable` is
  requested once more; the credit links to
  `link`; the footer attribution is present.

## Left to the builder

- Plan slicing. Suggested order: ids + importer + backfill; then the art endpoint; then the web.
- Cache implementation and exact size bound.
- The placeholder's exact styling within the existing design tokens.
- Whether the TMDB client uses the v3 key as a query parameter or the v4 read token as a bearer
  header. Either way, it must never be logged.

## Production Annotations

- The art cache and the source rate limits live in process memory. They reset on deploy and are per
  instance, so N replicas make up to N times the outbound calls. Fix: a shared store before running
  more than one instance.
