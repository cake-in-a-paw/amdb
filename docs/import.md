# Seeding AMDB from Wikidata

Runbook for `pnpm --filter @amdb/api import:wikidata`. It reads Wikidata (CC0) and adds works,
creators, series, franchises and genre tags to the catalog. Runs are additive: they never edit or
remove what is already there, and a re-run skips works it already imported. Every change is
attributed to an import run; see `/api/import-runs/<id>` for a run's params, status and stats.

Flags (all optional):

| Flag               | Default         | Meaning                                              |
| ------------------ | --------------- | ---------------------------------------------------- |
| `--limit`          | `1000`          | Most works to consider, by sitelink count            |
| `--min-sitelinks`  | `5`             | Wikipedia-language floor for a work                  |
| `--classes`        | all five        | Comma list of Wikidata class QIDs                    |
| `--max-db-bytes`   | `3500000000`    | Stop before a batch once the database is this big    |
| `--dry-run`        |                 | Fetch and map only; writes nothing, no `DATABASE_URL`|
| `--backfill`       |                 | Add missing references to imported works (§6); not with `--dry-run` |

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

## 6. Backfill references

Works imported before the importer read Wikidata's `mul` label are missing some references: a
director, studio, series, franchise or genre whose name was only under `mul` was dropped, and a work
link whose target was skipped was never added. A normal re-run skips those works as `present`, so
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
reference with its wikidata id as a normal run would.

What it never does: create or edit a work, change a field, remove a relation, or touch a work's
external ids. It never re-adds a relation that AMDB holds or ever held (so a moderator's unrelate
sticks), and leaves alone works a person entered, even with a wikidata id. A candidate not in AMDB
is counted `not_present`, not imported.

Read the stats: `backfilled` (works that got a relation), `relationsAdded`, `upToDate` (imported
works with nothing to add), and `skipped.present` (works it may not touch). A second backfill should
show `backfilled: 0`.
