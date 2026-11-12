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

- Only items with an English label (the `en` label, else the `mul` "all languages" label, where Wikidata now keeps many titles and names, e.g. Forrest Gump), applied when mapping (items without one are skipped as `no_title`), not in the query: the label join makes the film query exceed the 60-second limit. An item in two classes takes the first match in this order:
  anime film, anime series, film, TV series, literary work.
- **Popularity order:** items are ranked by sitelink count (`wikibase:sitelinks`), most first,
  and imported in that order, so a capped seed holds the best-known works.

| Wikidata | AMDB |
|---|---|
| English label (`en`, else `mul`) | `title` |
| P1476 title, when not English | `originalTitle` |
| Aliases: English (`aliases.en`) in Wikidata's order, then language-neutral (`aliases.mul`) whose letters are all Latin script; trimmed, empty ones and those over 500 characters dropped, minus any equal to the title or original title, deduped; a create keeps the first 50 | works: `alternateTitles`; creators: `alternateNames` (series, properties and tags take none) |
| English description | `description` |
| P577 publication date, earliest (else P580 start time); precision day, month or year only | `releaseYear/Month/Day` |
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
| the item's QID, P345 IMDb ID, P648 Open Library ID, P212 ISBN-13, P4947 TMDB movie ID, P4983 TMDB TV ID, P8729 AniList anime ID | external ids `wikidata`, `imdb`, `openlibrary`, `isbn13`, `tmdb_movie`, `tmdb_tv`, `anilist` (the TMDB and AniList ids must be positive integers) |

- A creator is a `person` if it is an instance of Q5 human, otherwise an `organization`.
  Creators, series and properties carry their own `wikidata` external id, so they are matched,
  not duplicated, across works and runs.
- A genre tag's name is its English label with a trailing " film", " television series",
  " television program", " novel" or " literature" removed; its slug is that name lowercased,
  non-alphanumerics collapsed to `-`. Tags are matched by slug.
- Cast (P161) is not imported: AMDB has no performer role.

## How it writes

- Each run is an `import_runs` row (source, parameters, evidence URL and its check date, start,
  finish, status, counts). One run at a time: a second one is refused while one is `running`, and
  an interrupt (Ctrl-C, SIGTERM) finishes a run as `failed`, "interrupted". Its submissions are authored by the run, not a user or a token, and their changes are
  stored as `approved` and applied at once (§6.2: no per-record queue). History shows them as a
  Wikidata import; moderators revert or correct them like any change.
- One submission per work: the work's create plus the creates and relations it needs, so one
  bad item never blocks another.
- **Re-runs are additive.** A work whose QID is already in AMDB, or was reverted or removed from
  it, is skipped, so a second run imports only what the first didn't and a revert sticks. A
  creator, series or property reference a moderator reverted is dropped the same way, not
  recreated (2026-11-09). A reference a person entered by hand is adopted rather than duplicated
  when it is the only listed entry of its kind (and, for a creator, person or organization) under
  that normalized name and has never held a wikidata id; it gets the wikidata id. With several
  such entries the run creates its own rather than guess (owner, 2026-11-09). A QID a moderator
  removed from any entity is never handed to an entry this way. Each adoption is logged and counted
  in `refsAdopted`. A candidate AMDB holds as another kind (say, a series) is skipped as `held_as_other`. Works win: no
  discovered candidate, even one past `--limit`, is created as a creator, series or property. Refreshing fields a run already wrote, and deciding what happens
  when a refresh disagrees with a human edit, is left to a later importer version.
- A work link whose target isn't in AMDB yet is kept for the end of the run and added then if the
  target arrived.

## Backfill

A run with `--backfill` adds the references imported works are missing (dropped by an earlier
importer version, or a link whose target arrived in a later run) and the external ids their
items now carry, plus aliases appended to name lists only import runs ever set, and nothing else.

- It walks the same ranked candidates and acts only on works an import run created: the work's
  `create` and its live wikidata id came from the same import-run submission, and the work is live
  and not merged away. A work a person entered is skipped as `present`; a candidate not in AMDB is
  skipped as `not_present`, never imported.
- Each such work gets at most one submission of the backfill run (`params.backfill: true`), through
  the same revision-logged path: creates for new references (with their wikidata id) and relations.
  No work create, no unrelate, and no update but two: the work's `alternateTitles` and each
  credited imported creator's `alternateNames` (created by an import run, as for works). It may
  change a list when every change that ever set that key came from an import run (its submission
  has an `import_run_id`), in any status; no merge ever went into or out of the entity; and no
  redacted create or update on it hides what it held. A person's change of any status blocks the
  list for good, and so does a revert, of any status, of a change that set it (an import's
  included); a revert of an unrelated change doesn't. For a list it may change, it appends the
  item's aliases (`en` then Latin-script `mul`, uncapped) that the list doesn't hold, after its
  current names, until it holds 50; it never removes or reorders a name (counted `namesAdded`; a
  creator credited by several works gets one update per run). The aliases are first checked
  against the main names the entity holds in AMDB (read per batch: a work's title and original
  title, a creator's name), and a list that wouldn't change is no update. Each update sends the
  list it read, and the write's transaction checks, with the entities locked, that every such
  list is still that list and still open. A submission rejected `duplicate_name` or
  `too_many_names` (a name matches a title a person changed during the run) or `names_changed` (a
  person touched a list since it was read) is retried without the name updates, and logged. A
  work with nothing to add gets no submission and counts as `upToDate`.
- External ids follow the artwork spec: a work gains each non-`wikidata` id whose scheme it never
  had, live or removed (so a moderator's removal sticks), and that no other live entity holds or
  an earlier work in the same run just claimed (counted `idsSkippedHeld`). A submission that
  still fails `duplicate_external_id` is retried once without the ids, as a normal run does.
- A removal sticks: a relation is skipped if `relations` holds any row, live or removed, with the
  same type, ends and role.
- References resolve by the normal run's rules (works win, a QID held as another kind or removed is
  dropped, a retracted tag's slug is dropped, one QID in two roles keeps the first). A link whose
  target isn't in AMDB stays missing: a backfill imports no works, so none is deferred.

## Being a good client

- User-Agent `AMDB-importer/<version> (https://github.com/cake-in-a-paw/amdb)`; no email (the repo
  is public).
- Requests are serial. Query service: one query at a time, under its 60-second limit. Entity API:
  at most 2 requests a second, `maxlag=5`.
- Query-service requests time out at 65 seconds (its own limit is 60); entity API requests at 30 seconds. A 429, 502, 503 or 504 waits for `Retry-After` (or 5 s, then 10 s,
  then 20 s), up to 5 tries. A source that stays down ends the run as `failed` with the reason; work
  already committed stays.

## Size

- A run stops before a batch once `pg_database_size` reaches `--max-db-bytes`, which defaults to
  3.5 GB (70% of Hobby's 5 GB). The run records how far it got and the bytes per work it measured.
