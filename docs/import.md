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

The stats print as one JSON line on stdout and progress on stderr. Exit 0 for `finished` or
`capped`, 1 for `failed` or any error.

One run at a time: a second run started while one is `running` stops at once with "another import
run is already running". Ctrl-C (or SIGTERM) stops a run after the work in hand and records it as
`failed` with the error `interrupted`; what it committed stays, and a later run carries on. The
stop waits for the request in hand, which can take minutes while Wikidata is retrying. A second
Ctrl-C quits at once, but then the run is never finished: close it as below.

If a run died without finishing (a second Ctrl-C, the process was killed, or the connection
dropped), its row stays
`running` and blocks the next run. Once you are sure it isn't running, close it by hand:

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

The importer applies pending migrations from the checkout it runs in, so run it from a clean
checkout of the exact `main` commit Railway has deployed, after that deploy has finished (an older
checkout would miss migrations, a newer one would apply ones the deployed app doesn't know):

```sh
git fetch origin && git switch --detach <deployed commit> && git status   # must be clean
pnpm install --frozen-lockfile
```

`railway run --service postgres` runs a local command with the Postgres service's variables. Its
`DATABASE_URL` is the private network address, which a laptop can't reach, so point the importer at
`DATABASE_PUBLIC_URL` inside the child shell (the single quotes keep the URL out of your shell and
history):

```sh
railway run --service postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm --filter @amdb/api import:wikidata --limit N'
```

If the project has more than one environment, add `-e production` to `railway run`. The public
proxy adds a round trip to every query, so a run is much slower than step 2's local one.

Pick N from step 2 so that the current size plus `N * bytesPerWork` stays under 70% of the volume.

Verify: `status` is `finished` and `/api/import-runs/<id>` shows the stats.

## 4. Check the site, then raise the limit

Browse the live site. If it looks right, run again with a larger `--limit`. Already imported works
are skipped, so a later run only adds the new ranks.

## 5. Grow the volume before the cap

Upgrade to Railway Pro and grow the volume before the projection passes 3.5 GB. `--max-db-bytes`
is the backstop: a run stops with `capped` instead of filling the disk.
