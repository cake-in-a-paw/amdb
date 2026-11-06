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

Get the public database URL: `railway run --service postgres` gives `DATABASE_PUBLIC_URL`. Then:

```sh
DATABASE_URL=$DATABASE_PUBLIC_URL pnpm --filter @amdb/api import:wikidata --limit N
```

Pick N from step 2 so that the current size plus `N * bytesPerWork` stays under 70% of the volume.

Verify: `status` is `finished` and `/api/import-runs/<id>` shows the stats.

## 4. Check the site, then raise the limit

Browse the live site. If it looks right, run again with a larger `--limit`. Already imported works
are skipped, so a later run only adds the new ranks.

## 5. Grow the volume before the cap

Upgrade to Railway Pro and grow the volume before the projection passes 3.5 GB. `--max-db-bytes`
is the backstop: a run stops with `capped` instead of filling the disk.
