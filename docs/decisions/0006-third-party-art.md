# 0006. Show third-party art by linking live, with credit

- **Status:** accepted (owner, 2026-11-07)
- **Date:** 2026-11-08

## Context

Work pages and lists look bare without posters and covers. Almost all cover art is copyrighted,
so under constitution principle II ("Everything Is CC0") and design spec §4.4, AMDB can host only
CC0 or public-domain images, and nearly every modern work has none.

The identifiers that point at sites with art (TMDB movie and TV ids, AniList anime ids, Open
Library ids) are Wikidata main-namespace statements, so they are CC0 and AMDB can hold them like
any other external id. The images themselves are not CC0.

The sources' terms, as recorded in the artwork spec (`docs/superpowers/specs/2026-11-07-artwork-design.md`,
"Sources and terms"), checked 2026-11-07:

- **TMDB** (https://www.themoviedb.org/api-terms-of-use): free for non-commercial use only. §2.A:
  commercial use, including using TMDB content to drive revenue for a website, needs a written
  agreement. AMDB must show the TMDB logo, less prominent than AMDB's own marks, and the notice
  "This product uses the TMDB API but is not endorsed or certified by TMDB." It must not cache
  TMDB information for more than 6 months, and must not use TMDB as an image host for unrelated
  graphics.
- **Open Library** (https://openlibrary.org/dev/docs/api/covers): use `covers.openlibrary.org`
  URLs as the `src` on public pages. Don't crawl or bulk-download. A courtesy link back is
  appreciated. Lookups by OLID or cover id are not rate-limited; lookups by ISBN are (100 per IP
  per 5 minutes), so AMDB doesn't use ISBN lookups.
- **AniList** (https://docs.anilist.co/guide/terms-of-use): free, including commercial use under
  $150 a month. Not for competing list or tracker services; AMDB is a catalog, not a tracker.
  30 requests a minute while AniList is degraded (normally 90). No storage or hoarding.

## Decision

- Amend principle II with a new rule (constitution 0.1.0 → 0.2.0, MINOR):

  > - Third-party art may be shown by linking live to its source, with credit. AMDB never
  >   stores, imports or exports it, and it isn't part of the dataset (V). Only the identifier
  >   that locates it is data.

- AMDB stores only the ids (`tmdb_movie`, `tmdb_tv`, `anilist`, plus the existing
  `openlibrary`). When a page is shown, `GET /api/art` looks the image up live and the browser
  loads it straight from the source's domain, with a credit linking to the work's page there.
  No image URL, poster path or cover id is written to the database, the revision log, the
  entity reads or the dumps.
- TMDB is preferred for film, TV and anime, Open Library covers books, and AniList is used only
  when no other source has an image. A source that fails makes the work "unavailable"; another
  source never stands in for it.
- The lookups follow the importer's rules (II): a timeout, a rate limit per source, `Retry-After`
  honored. Answers are cached in memory only (found 7 days, none 1 day), far inside TMDB's
  6-month limit.

**Non-commercial condition.** AMDB earns nothing today, so TMDB's free terms fit. Spec §7 plans
paid credits later. Before any paid access ships, re-check TMDB's terms: it may need a
commercial agreement, or TMDB art switched off. The art endpoint is unmetered and never costs
credits, but TMDB judges the site as a whole.

## Alternatives considered

- **No art at all** — rejected: work pages and lists stay bare, which is the problem this solves.
- **Host only CC0 or public-domain images** (§4.4's v1 rule) — kept for anything AMDB hosts, but
  rejected as the only source of art: it leaves almost every modern work without a cover.
- **Store the image URLs or poster paths** — rejected: they are not CC0, and storing them would
  put non-CC0 values in the dataset (V) and run against TMDB's caching and AniList's storage
  terms.
- **Proxy or resize the image bytes through AMDB** — rejected: that copies the image through
  AMDB, which the artwork spec rules out (no hosting, resizing or proxying of image bytes; the
  browser never fetches art through AMDB), and §4.4 still lets AMDB host only CC0 or
  public-domain images.

## Consequences

- Posters and covers appear without any non-CC0 data entering the dataset; the ids stay CC0.
- Art depends on outside services at view time. An outage shows a placeholder, never an error.
- The footer must carry TMDB's logo and notice for as long as TMDB art is shown.
- The cache and the source limits are per process (spec Production Annotations). More than one
  instance needs a shared store.
- Revisit before any paid access ships (TMDB's non-commercial condition), or if a source's terms
  change.
