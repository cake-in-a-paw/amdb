# Wikidata seed importer

The importer's spec that constitution II and design §6.2 call for: what it reads, the license
evidence, what it maps and how it writes. It amends §6.2 as the owner decided on 2026-11-05.

## Decisions (owner, 2026-11-05)

- **Books come from Wikidata, not Open Library, for now.** Open Library's licensing page says only
  that the Internet Archive "does not assert any new copyright," and adds that "there may be
  existing rights issues on some contributions." That is not a CC0 dedication, so under
  constitution II it can't be a source yet. Its IDs (Wikidata P648) are stored as identifiers,
  which are facts. An Open Library importer can follow if Open Library confirms CC0.
- **Railway stays the host.** The seed is sized by a cap the operator sets. It starts inside
  Hobby's 5 GB volume; the operator upgrades to Pro when the measured size per work says the
  full seed needs more.

## License evidence

- Source: https://www.wikidata.org/wiki/Wikidata:Licensing (checked 2026-11-05): "All structured
  data (i.e. the main, Property, Lexeme, and EntitySchema namespaces) is released into the public
  domain under Creative Commons Zero."
- The importer reads only main-namespace items: labels, descriptions and statements. It never
  reads sitelinked Wikipedia text (CC BY-SA) or Commons media (§4.4 governs images; none are
  imported here).
- Each import run records this URL and the check date, so every imported field traces to a run
  and its evidence (§4.3).

## What it reads

| Selection | Wikidata class (`wdt:P31`) | AMDB |
|---|---|---|
| Films | Q11424 film | `film_tv` / `movie` |
| TV series | Q5398426 television series | `film_tv` / `series` |
| Anime series | Q63952888 anime television series | `film_tv` / `anime_series` |
| Anime films | Q20650540 anime film | `film_tv` / `anime_film` |
| Books | Q7725634 literary work | `book` |

- Only items with an English label. An item in two classes takes the first match in this order:
  anime film, anime series, film, TV series, literary work.
- **Popularity order:** items are ranked by sitelink count (`wikibase:sitelinks`), most first,
  and imported in that order, so a capped seed holds the best-known works.

| Wikidata | AMDB |
|---|---|
| English label | `title` |
| P1476 title, when not English | `originalTitle` |
| English description | `description` |
| P577 publication date, earliest; precision day, month or year only | `releaseYear/Month/Day` |
| date in the past / future / none | `lifecycle` `released` / `upcoming` / `unknown` |
| P2047 duration (minutes; seconds and hours converted) | `attributes.runtimeMin` |
| P1113 number of episodes | `attributes.episodes` |
| P1104 number of pages | `attributes.pageCount` |
| P57 director, P58 screenwriter, P170 creator, P162 producer, P86 composer, P272 production company | creator roles `director`, `writer`, `creator`, `producer`, `composer`, `studio` |
| P50 author, P110 illustrator, P655 translator, P98 editor | `author`, `illustrator`, `translator`, `editor` |
| P179 part of the series, with a P1545 ordinal that is a whole number | series, `position` (no ordinal: no link) |
| P8345 media franchise | property |
| P136 genre | tag, kind `genre` |
| P144 based on / P155 follows, when the target is in AMDB | work link `adapted_from` / `sequel_of` |
| the item's QID, P345 IMDb ID, P648 Open Library ID, P212 ISBN-13 | external ids `wikidata`, `imdb`, `openlibrary`, `isbn13` |

- A creator is a `person` if it is an instance of Q5 human, otherwise an `organization`.
  Creators, series and properties carry their own `wikidata` external id, so they are matched,
  not duplicated, across works and runs.
- A genre tag's name is its English label with a trailing " film", " television series",
  " television program", " novel" or " literature" removed; its slug is that name lowercased,
  non-alphanumerics collapsed to `-`. Tags are matched by slug.
- Cast (P161) is not imported: AMDB has no performer role.

## How it writes

- Each run is an `import_runs` row (source, parameters, evidence URL, start, finish, status,
  counts). Its submissions are authored by the run, not a user or a token, and their changes are
  stored as `approved` and applied at once (§6.2: no per-record queue). History shows them as a
  Wikidata import; moderators revert or correct them like any change.
- One submission per work: the work's create plus the creates and relations it needs, so one
  bad item never blocks another.
- **Re-runs are additive.** A work whose QID is already in AMDB is skipped, so a second run imports
  only what the first didn't. Refreshing fields a run already wrote, and deciding what happens
  when a refresh disagrees with a human edit, is left to a later importer version.
- A work link whose target isn't in AMDB yet is kept for the end of the run and added then if the
  target arrived.

## Being a good client

- User-Agent `AMDB-importer/<version> (https://github.com/cake-in-a-paw/amdb)`; no email (the repo
  is public).
- Requests are serial. Query service: one query at a time, under its 60-second limit. Entity API:
  at most 2 requests a second, `maxlag=5`.
- Every request has a 30-second timeout. A 429 or 503 waits for `Retry-After` (or 5 s, then 10 s,
  then 20 s), up to 5 tries. A source that stays down ends the run as `failed` with the reason; work
  already committed stays.

## Size

- A run stops before a batch once `pg_database_size` reaches `--max-db-bytes`, which defaults to
  3.5 GB (70% of Hobby's 5 GB). The run records how far it got and the bytes per work it measured.
