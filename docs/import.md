# Seeding AMDB from Wikidata

Runbook for `pnpm --filter @amdb/api import:wikidata`. It reads Wikidata (CC0) and adds works,
creators, series, franchises and genre tags to the catalog, and with `--parts` the seasons and
episodes of the shows it holds. Runs are additive: they never edit or
remove what is already there, and a re-run skips works it already imported. Every change is
attributed to an import run; see `/api/import-runs/<id>` for a run's params, status and stats.

Flags (all optional):

| Flag               | Default         | Meaning                                              |
| ------------------ | --------------- | ---------------------------------------------------- |
| `--limit`          | `1000`          | Most works to consider, by sitelink count; with `--parts`, most shows, by QID number |
| `--min-sitelinks`  | `5`             | Wikipedia-language floor for a work; not with `--parts` |
| `--classes`        | all five        | Comma list of Wikidata class QIDs; not with `--parts` |
| `--max-db-bytes`   | `3500000000`    | Stop before a batch (with `--parts`, a submission) once the database is this big |
| `--dry-run`        |                 | Fetch and map only; writes nothing. No `DATABASE_URL`, except with `--parts` (§7) |
| `--backfill`       |                 | Add missing references to imported works (§6); not with `--dry-run` or `--parts` |
| `--parts`          |                 | Import the seasons and episodes of shows AMDB holds (§7) |

The stats print as one JSON line on stdout and progress on stderr. Exit 0 for `finished` or
`capped`, 1 for `failed` or any error, 130 after a second Ctrl-C.

One run at a time: a second run started while one is `running` stops at once with "another import
run is already running". Ctrl-C (or SIGTERM) stops a run after the work in hand and records it as
`failed` with the error `interrupted`; what it committed stays, and a later run carries on. The
stop waits for the request in hand, which can take minutes while Wikidata is retrying. A second
Ctrl-C (at least 2 seconds after the first) quits at once, but then the run is never finished:
close it as below.

If a run died without finishing (a second Ctrl-C, the process was killed, or the connection
dropped), its row stays
`running` and blocks the next run. Once you are sure it isn't running, close it by hand. The run id
is in the "already running" refusal, or `SELECT id, started_at FROM import_runs WHERE status = 'running';`.
On production, `railway connect postgres` opens a psql session.

```sql
UPDATE import_runs SET status = 'failed', finished_at = now(), error = 'died'
WHERE id = '<run id>' AND status = 'running';
```

## 1. Dry run locally

```sh
pnpm --filter @amdb/api import:wikidata --dry-run --limit 20
```

Discovery runs one query per class; the film query takes about 20 seconds, so expect a wait.

Verify: counts (candidates, mapped, skipped) and three sample records that look right.

## 2. Import 1,000 into a local Postgres

```sh
DATABASE_URL=postgres://localhost/amdb_seed pnpm --filter @amdb/api import:wikidata --limit 1000
```

Use a throwaway database; migrations run on connect. Read `bytesPerWork` in the stats line.

Verify: `status` is `finished`, and the works look right in the app.

## 3. Production (needs the owner's go-ahead)

Do not run this without the owner saying so at that moment.

The Postgres service has no public address, so the import runs inside the deployed `app` container,
which reaches it over the private network with its own `DATABASE_URL`. That container is the deployed
`main` commit with its migrations already applied, so the code and schema always match. Wait for a
deploy to finish first, and don't deploy during a run: a redeploy kills the run and leaves it
`running` (close it as above).

Start the run detached, so a dropped SSH session doesn't stop it, and read its log later:

```sh
railway ssh --service app -- sh -c 'cd /app/apps/api && nohup pnpm import:wikidata --limit N --classes Q11424 > /tmp/import.log 2>&1 < /dev/null &'
railway ssh --service app -- tail -n 3 /tmp/import.log   # progress; the last line is the stats JSON when done
```

To stop a detached run, open a shell with `railway ssh --service app` and send SIGTERM to the
`tsx scripts/import-wikidata.ts` process; the run finishes as `interrupted`. The container has no
`pgrep`, so find the PID by reading `/proc/<pid>/cmdline`.

`railway ssh` signs in with an SSH key registered on Railway (`railway ssh keys list`); a key held
by a locked 1Password agent fails with "communication with agent failed", so unlock it first. If the
project has more than one environment, add `-e production`. The log is in the container's `/tmp`
and is gone after the next deploy; the run's stats stay at `/api/import-runs/<id>`.

Pick N from step 2 so that the current size plus `N * bytesPerWork` stays under 70% of the volume.

Verify: `status` is `finished` and `/api/import-runs/<id>` shows the stats.

## 4. Check the site, then raise the limit

Browse the live site. If it looks right, run again with a larger `--limit`. Already imported works
are skipped, so a later run only adds the new ranks.

## 5. Grow the volume before the cap

Upgrade to Railway Pro and grow the volume before the projection passes 3.5 GB. `--max-db-bytes`
is the backstop: a run stops with `capped` instead of filling the disk.

## 6. Backfill references and ids

Works imported before the importer read Wikidata's `mul` label are missing some references: a
director, studio, series, franchise or genre whose name was only under `mul` was dropped, and a work
link whose target was skipped was never added. Works are also missing the external ids Wikidata
has gained since (TMDB, AniList). A normal re-run skips those works as `present`, so
it never adds them. `--backfill` does:

```sh
railway ssh --service app -- sh -c 'cd /app/apps/api && nohup pnpm import:wikidata --backfill --limit N --classes Q11424 > /tmp/import.log 2>&1 < /dev/null &'
railway ssh --service app -- tail -n 3 /tmp/import.log
```

Use the same `--classes` and `--min-sitelinks` as the runs being backfilled, and the same or a
larger `--limit`: ranks shift as sitelinks change, and an extra candidate costs little (one not in
AMDB is only counted as `not_present`, never fetched). The same rules as a normal run apply: owner's go-ahead, one run at a time, the
size cap, Ctrl-C/SIGTERM, and closing a dead run by hand.

What it does: for each candidate that an import run created (and that is still live, not merged
away), it fetches the work from Wikidata again and adds, as one submission of the new run, the
creator, series, franchise, genre tag and work-link relations it is missing, creating a missing
reference with its wikidata id as a normal run would. Like a normal run, when a person already
entered that reference by hand (the only entry of its kind under that name, never given a wikidata
id), it uses that entry and gives it the wikidata id; with several such entries it creates its own.
It never does this for a QID a moderator removed from any entity. It also adds the work's `tmdb_movie`,
`tmdb_tv`, `anilist`, `imdb`, `openlibrary` and `isbn13` ids of a scheme the work never had, unless
another live entity already holds that id. And it gives the work, and each creator an import run
created that the work credits, its aliases as `alternateTitles` / `alternateNames`: the English
(`en`) ones, then the language-neutral (`mul`) ones written only in Latin script. It does so only
if every change that ever set that list came from an import run (in any status), nothing was ever
merged into or out of the entity, and no create or update on it was redacted. A person's edit, a
person's pending change, one a moderator rejected, or a revert (in any status) of a change that set
the list (an import's included, so a list reverted even back to what an import wrote stays put)
blocks the list for good; a revert of an unrelated change, such as a title edit, doesn't. It only appends: the aliases the list doesn't hold yet go after its current names,
until it holds 50; it never removes or reorders a name, and a list it wouldn't change gets no
update. Aliases that repeat the title, original title or name AMDB holds now (a person may have
renamed the entry) are left out. Each list is checked again, locked, as the update is written: one
a person touched since the run read it is left alone, and the skip is logged (`names_changed`).

Names make a backfill longer. AMDB already holds the creators the works credit, so a normal run
never fetches them again; a names backfill fetches each creator it may name from Wikidata, once per
run. With about 100,000 such creators that is about 2,000 extra entity requests (50 ids each). The
client starts requests at least 0.5 s apart, so this adds at least 17 minutes, and about an hour
at one to two seconds per request. A second names backfill (to bring `mul` aliases to lists the
first one set from `en` alone) fetches the same items: the first took 2.5 hours for films, TV and
books and grew the database by 44 MB, so expect similar time and less growth.

What it never does: create a work, change any other field, remove a relation, or remove an external id.
It never re-adds a relation or an id scheme that AMDB holds or ever held (so a moderator's unrelate
sticks, even after either end is merged into another entity), never recreates a reference a
moderator reverted, and leaves alone works a person entered, even with a wikidata id. A candidate not in AMDB
is counted `not_present`, not imported.

Read the stats: `backfilled` (works that got a new reference relation, external id or name list), `relationsAdded`, `idsAdded` (external ids added), `namesAdded` (works and creators given a names update, appends included; a name clashing with a title a person changed during the run, or a list a person touched since the run read it, drops that work's name updates, logged), `idsSkippedHeld` (ids another entity already holds), `refsAdopted` (hand-entered references used instead of creating new ones; each is logged), `upToDate` (imported
works with nothing to add), and `skipped.present` (works it may not touch). A second backfill should
show `backfilled: 0`.

## 7. Seasons and episodes

`--parts` imports every season and episode Wikidata has for the shows AMDB holds: the listed works
of subtype `series` or `anime_series` with a wikidata id, taken by QID number (`--limit` is the most
shows). Ordinary runs never fetch parts. The same rules as a normal run apply: the owner's go-ahead
at that moment, one run at a time, never during a deploy, the size cap, Ctrl-C/SIGTERM, and closing
a dead run by hand.

What it reads: per 50 shows, one query for items whose `P179` (part of the series) is the show and
whose class is the season class Q3464665 or any subclass of it (`P31/P279*`), and one for the
episode class Q21191270 the same way, so anime episodes and other subclasses come too. An item in
both is a season. A query Wikidata can't answer is asked again one show at a time; if one show's
query still fails, the run fails. It then fetches each show, its seasons and its new episodes.

Where a part goes: a season under its show, numbered by its `P1545` on `P179`, else its place in
the show's `P527` list. An episode under its `P4908` season when that season is under the show; else
under the one season whose `P527` lists it; else, when the show has no seasons at all, directly
under the show by its overall number. Any other episode is counted `partsUnplaced` and never
created. A part gets its fields, its external ids (`imdb`, `tmdb_season`, `tmdb_episode`, …) and the
credits to creators AMDB already holds live; it never creates a creator, and adds no tags, no work
links (`P155`/`P156` aren't sequels) and no series membership (`P179` gives the parent).

How it writes: one submission per season, holding the season, its `work_part` from the show, and
each new episode with its `work_part` from the season. Episodes directly under a show go 25 to a
submission. The size cap is checked before each submission, so a capped run never leaves an
episode without its season and show. A submission refused for a duplicate external id is retried
once with only wikidata ids; any other refusal skips that season's parts (logged as
`skipped parts of <QID>: …`) and the run goes on.

Re-runs add only what Wikidata has gained: a part already in AMDB is never moved or changed, and a
part a moderator reverted stays reverted. A part a person entered by hand under the same parent,
never given a wikidata id, is adopted rather than duplicated when it is the only one there with the
same subtype and number (or, for an unnumbered part, the same title): it gets the wikidata id and
nothing else changes. That never happens for a QID a moderator removed from any entity.

Step 1, the bytes per part. Run a real `--parts` run into a local database that holds shows (imported
as in §2), and read `bytesPerPart` in its stats:

```sh
DATABASE_URL=postgres://localhost/amdb_seed pnpm --filter @amdb/api import:wikidata --parts --limit 20
```

A local database holds few creators, so most episode credits are skipped there (`creditsSkipped`)
and this figure leaves their rows out. Step 3 measures them.

Step 2, the projection. The current size plus about 211,000 × `bytesPerPart` must stay under the
3.5 GB cap. If it doesn't, grow the volume first (§5).

Step 3, with the owner's go-ahead, a first production run of a couple hundred shows, detached as
in §3:

```sh
railway ssh --service app -- sh -c 'cd /app/apps/api && nohup pnpm import:wikidata --parts --limit 200 > /tmp/import.log 2>&1 < /dev/null &'
railway ssh --service app -- tail -n 3 /tmp/import.log
```

When it finishes, check `partsByClass`: a subclass with a large count that isn't really a season or
an episode shows up here, before the rest of the shows bring more of it. Redo the projection with
this run's `bytesPerPart`, which now includes the credits, and look at a few of its shows' seasons
and episodes, and a creator credited on them, in the app.

Step 4, with the owner's go-ahead, the rest: the same command with a `--limit` above the number of
shows AMDB holds (the default is 1,000). It starts again from the first show; the parts step 3 added
count as `partsPresent`.

The dry run, `--parts --dry-run --limit N`, reads the database and Wikidata, writes nothing and
starts no run, and prints `{ dryRun, parts, shows, partsFound, partsByClass, placed, partsUnplaced,
partsHeldAsRoot, creditsSkipped }`. It fetches every part as a real run does, so it costs about as
much Wikidata time; step 3 gives the same class check with real stats. It needs `DATABASE_URL`, and
connecting runs pending migrations, so point it only at an already-migrated database.

Read the stats: `candidates` (shows considered), `shows` (those Wikidata lists any part for),
`partsFound` (seasons and episodes discovered) and `partsByClass` (the same by class QID: the base
class, else the item's lowest-numbered subclass), `partsAdded`, `partsPresent` (already in AMDB, or
held by a removed entry: never moved), `partsAdopted` (hand-entered parts given their wikidata id;
each is logged), `partsHeldAsRoot` (held as a work that isn't a part, such as a series: its subtype
is never changed), `partsUnplaced`, `partsSkipped` (`no_title`, `held_as_other` for a QID held as
another kind of entry, such as a creator, `reverted`, `invalid` for parts in a refused submission, `missing`
for a QID Wikidata no longer has), `creditsSkipped` (credits to creators AMDB doesn't hold),
`bytesPerPart`, `stoppedAt` (the rank of the last show done) and `bytesStart`/`bytesEnd`. `imported`
and `bytesPerWork` stay 0. A second run should show `partsAdded: 0`.
