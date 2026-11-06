// Seeds AMDB from Wikidata. See docs/import.md. Progress goes to stderr, the stats to stdout.
import { openDb } from '../src/platform/db/open';
import { createWikidataClient } from '../src/features/imports/wikidata/client';
import { discover } from '../src/features/imports/wikidata/discover';
import { mapWork, type WorkRecord } from '../src/features/imports/wikidata/map';
import { runWikidataImport } from '../src/features/imports/wikidata/run';
import { type ImportArgs, parseArgs } from './import-wikidata-args';

const log = (line: string) => process.stderr.write(`${line}\n`);

// Read-only: discover, fetch and map the first `limit` candidates; nothing is written anywhere.
async function dryRun(args: ImportArgs) {
  const client = createWikidataClient({ fetch });
  const candidates = (await discover(client, args)).slice(0, args.limit);
  log(`${candidates.length} candidates`);
  const entities: Awaited<ReturnType<typeof client.entities>> = {};
  for (let i = 0; i < candidates.length; i += 50)
    Object.assign(entities, await client.entities(candidates.slice(i, i + 50).map((c) => c.qid)));
  const skipped = { no_title: 0, missing: 0 };
  const samples: WorkRecord[] = [];
  let mapped = 0;
  for (const c of candidates) {
    const entity = entities[c.qid];
    if (!entity) {
      skipped.missing++;
      continue;
    }
    const rec = mapWork(entity, c, new Date());
    if ('skip' in rec) skipped[rec.skip]++;
    else {
      mapped++;
      if (samples.length < 3) samples.push(rec);
    }
  }
  process.stdout.write(`${JSON.stringify({ dryRun: true, candidates: candidates.length, mapped, skipped })}\n`);
  for (const s of samples) log(JSON.stringify(s, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) return dryRun(args);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { db, close } = await openDb(url);
  // Ctrl-C or a SIGTERM finishes the run as failed ("interrupted") after the current work; a second one quits at once.
  const controller = new AbortController();
  const onSignal = () => {
    if (controller.signal.aborted) process.exit(130);
    log('interrupting after the current work (press again to quit now)');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const { status, stats, runId } = await runWikidataImport(
      { db, client: createWikidataClient({ fetch }), log, signal: controller.signal },
      args,
    );
    process.stdout.write(`${JSON.stringify({ runId, status, ...stats })}\n`);
    if (status === 'failed') process.exitCode = 1;
  } finally {
    await close();
  }
}

main().catch((err) => {
  // One line on stderr, no stack (an unavailable Wikidata is expected weather).
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
