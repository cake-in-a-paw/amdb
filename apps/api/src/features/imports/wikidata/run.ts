// Drives a Wikidata seed import: discover → fetch → map → one revision-logged submission per work.
import type { EntityKind, WorkLinkType } from '@amdb/shared';
import type { Db } from '../../../platform/db/types';
import { ApiError } from '../../../platform/http/errors';
import type { ChangeInput, EntityRef } from '../../changes/schemas';
import { createChangesService } from '../../changes/service';
import { createImportsService } from '../service';
import { type WikidataClient, type WikidataEntity, WikidataUnavailable } from './client';
import { discover } from './discover';
import { genreTag, mapRef, mapWork, type WorkRecord } from './map';

const LICENSE_URL = 'https://www.wikidata.org/wiki/Wikidata:Licensing';
/** The entity API's per-request cap (the client rejects more). */
const MAX_IDS = 50;

export type SkipReason = 'present' | 'no_title' | 'duplicate_external_id' | 'missing' | 'invalid';

export type WikidataImportStats = {
  /** Candidates after `limit`. */
  candidates: number;
  imported: number;
  skipped: Record<SkipReason, number>;
  /** Work links added in the final pass, once their target had arrived. */
  linksAdded: number;
  /** Final-pass links that couldn't be added (their work was imported all the same). */
  linksFailed: number;
  bytesStart: number;
  bytesEnd: number;
  bytesPerWork: number;
  /** The 1-based rank of the last candidate the run dealt with. */
  stoppedAt: number;
};

export type RunStatus = 'finished' | 'capped' | 'failed';

export interface RunDeps {
  db: Db;
  client: WikidataClient;
  /** Defaults to `pg_database_size` of the current database. */
  measureBytes?: () => Promise<number>;
  today?: Date;
  log?: (line: string) => void;
}

export interface RunOptions {
  classes: string[];
  minSitelinks: number;
  limit: number;
  maxDbBytes: number;
  batchSize?: number;
}

type Known = { id: string; kind: EntityKind };
type RefKind = 'creator' | 'series' | 'property';

/** A work link whose target wasn't in AMDB when its work went in. */
interface DeferredLink {
  fromId: string;
  toQid: string;
  linkType: WorkLinkType;
}

/** What a create in a submission stands for, so its returned entity id can be remembered. */
type CreatedKey = { index: number; qid: string; kind: EntityKind } | { index: number; slug: string };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A 4xx from planning or applying: about this one item, never the run. */
const isItemError = (err: unknown): err is ApiError => err instanceof ApiError && err.status < 500;

export async function runWikidataImport(
  deps: RunDeps,
  opts: RunOptions,
): Promise<{ runId: string; status: RunStatus; stats: WikidataImportStats }> {
  const imports = createImportsService(deps.db);
  const changes = createChangesService(deps.db);
  const measure = deps.measureBytes ?? (() => imports.databaseBytes());
  const today = deps.today ?? new Date();
  const log = deps.log ?? (() => {});
  const batchSize = opts.batchSize ?? 50;

  const { id: runId } = await imports.startRun({
    source: 'wikidata',
    params: { ...opts, batchSize },
    licenseUrl: LICENSE_URL,
  });
  const stats: WikidataImportStats = {
    candidates: 0,
    imported: 0,
    skipped: { present: 0, no_title: 0, duplicate_external_id: 0, missing: 0, invalid: 0 },
    linksAdded: 0,
    linksFailed: 0,
    bytesStart: 0,
    bytesEnd: 0,
    bytesPerWork: 0,
    stoppedAt: 0,
  };

  // Run-local memory: entities by QID (found in AMDB or created by this run), fetched reference
  // items (null when Wikidata didn't return one), and genre tags by slug (null for a slug held by a
  // retracted or removed tag, which can't be reused or recreated).
  const known = new Map<string, Known>();
  const refEntities = new Map<string, WikidataEntity | null>();
  const tagIds = new Map<string, string | null>();
  const deferred: DeferredLink[] = [];

  async function fetchEntities(qids: string[]) {
    const out: Record<string, WikidataEntity> = {};
    for (let i = 0; i < qids.length; i += MAX_IDS)
      Object.assign(out, await deps.client.entities(qids.slice(i, i + MAX_IDS)));
    return out;
  }

  async function remember(qids: string[]) {
    for (const [qid, entity] of await imports.findByWikidataIds(qids)) known.set(qid, entity);
  }

  /** One work's submission: its create, creates for new references, its relations and external ids. */
  async function buildChanges(rec: WorkRecord) {
    const creates: ChangeInput[] = [{ op: 'create', kind: 'work', ref: 'w', fields: rec.fields }];
    const relates: ChangeInput[] = [];
    const created: CreatedKey[] = [{ index: 0, qid: rec.qid, kind: 'work' }];
    const work: EntityRef = { ref: 'w' };
    const local = new Map<string, EntityRef>();
    const slugs = new Set<string>();

    const nextRef = () => `r${creates.length}`;
    const entityRef = (qid: string, kind: RefKind): EntityRef | null => {
      const found = known.get(qid);
      // Held as another kind (say, a series item imported as a work): drop the reference, keep the work.
      if (found) return found.kind === kind ? { id: found.id } : null;
      const already = local.get(qid);
      if (already) return already;
      const entity = refEntities.get(qid);
      const mapped = entity ? mapRef(entity) : null;
      if (!mapped) return null;
      const ref = nextRef();
      const description = mapped.description === undefined ? {} : { description: mapped.description };
      const fields =
        kind === 'creator'
          ? { name: mapped.name, kind: mapped.kind, ...description }
          : { title: mapped.name, ...description };
      created.push({ index: creates.length, qid, kind });
      creates.push({ op: 'create', kind, ref, fields });
      relates.push({ op: 'relate', type: 'external_id', from: { ref }, data: { scheme: 'wikidata', value: qid } });
      local.set(qid, { ref });
      return { ref };
    };
    const tagRef = async (qid: string): Promise<EntityRef | null> => {
      const label = refEntities.get(qid)?.labels?.en?.value;
      const tag = label ? genreTag(label) : null;
      // Two genres can share a slug ("drama film", "drama"); the work gets the tag once.
      if (!tag || slugs.has(tag.slug)) return null;
      slugs.add(tag.slug);
      if (!tagIds.has(tag.slug)) {
        const holder = await changes.tagBySlug(tag.slug);
        if (holder) tagIds.set(tag.slug, holder.live ? holder.id : null);
      }
      const id = tagIds.get(tag.slug);
      if (id === null) return null;
      if (id) return { id };
      const ref = nextRef();
      created.push({ index: creates.length, slug: tag.slug });
      creates.push({ op: 'create', kind: 'tag', ref, fields: { kind: 'genre', name: tag.name, slug: tag.slug } });
      return { ref };
    };

    for (const { qid, role } of rec.creators) {
      const to = entityRef(qid, 'creator');
      if (to) relates.push({ op: 'relate', type: 'work_creator', from: work, to, data: { role } });
    }
    for (const { qid, position } of rec.series) {
      const from = entityRef(qid, 'series');
      if (from) relates.push({ op: 'relate', type: 'series_work', from, to: work, data: { position } });
    }
    for (const qid of rec.franchises) {
      const from = entityRef(qid, 'property');
      if (from) relates.push({ op: 'relate', type: 'property_work', from, to: work, data: {} });
    }
    for (const qid of rec.genres) {
      const to = await tagRef(qid);
      if (to) relates.push({ op: 'relate', type: 'work_tag', from: work, to, data: {} });
    }
    for (const { scheme, value } of rec.externalIds) {
      relates.push({ op: 'relate', type: 'external_id', from: work, data: { scheme, value } });
    }
    const later: Omit<DeferredLink, 'fromId'>[] = [];
    for (const { qid, linkType } of rec.links) {
      if (qid === rec.qid) continue;
      const target = known.get(qid);
      if (!target) later.push({ toQid: qid, linkType });
      // A link is garnish: one to something that isn't a work is dropped, not allowed to sink the work.
      else if (target.kind === 'work')
        relates.push({ op: 'relate', type: 'work_link', from: work, to: { id: target.id }, data: { linkType } });
    }
    return { changes: [...creates, ...relates], created, later };
  }

  async function submitWork(rec: WorkRecord) {
    const built = await buildChanges(rec);
    const result = await changes.importSubmission(runId, built.changes);
    // Only a committed submission's entities exist; a failed one rolled back, so nothing is remembered.
    for (const key of built.created) {
      const entityId = result.changes[key.index]?.entityId;
      if (!entityId) throw new Error(`importSubmission returned no entity for change ${key.index + 1}`);
      if ('slug' in key) tagIds.set(key.slug, entityId);
      else known.set(key.qid, { id: entityId, kind: key.kind });
    }
    const workId = result.changes[0]?.entityId;
    // Checked in the loop above: change 0 is the work's create.
    for (const link of built.later) deferred.push({ ...link, fromId: workId! });
  }

  async function importWork(record: WorkRecord) {
    let rec = record;
    for (let retried = false; ; retried = true) {
      try {
        await submitWork(rec);
        stats.imported++;
        return;
      } catch (err) {
        if (!isItemError(err)) throw err;
        if (err.code === 'duplicate_external_id' && !retried) {
          // Another work already holds one of its ids (say, a shared IMDb id): keep the work, drop the rest.
          rec = { ...rec, externalIds: rec.externalIds.filter((e) => e.scheme === 'wikidata') };
          continue;
        }
        const reason: SkipReason = err.code === 'duplicate_external_id' ? 'duplicate_external_id' : 'invalid';
        stats.skipped[reason]++;
        log(`skipped ${rec.qid}: ${err.code} (${err.message})`);
        return;
      }
    }
  }

  async function importCandidates() {
    stats.bytesStart = await measure();
    const candidates = (await discover(deps.client, opts)).slice(0, opts.limit);
    stats.candidates = candidates.length;
    log(`${candidates.length} candidates`);

    for (let start = 0; start < candidates.length; start += batchSize) {
      const bytes = await measure();
      if (bytes >= opts.maxDbBytes) {
        log(`capped at ${bytes} bytes before rank ${start + 1}`);
        return 'capped' as const;
      }
      const batch = candidates.slice(start, start + batchSize);
      await remember(batch.map((c) => c.qid));
      const fresh = batch.filter((c) => !known.has(c.qid));
      const fetched = await fetchEntities(fresh.map((c) => c.qid));
      const records = new Map<string, WorkRecord | { skip: 'no_title' }>();
      for (const c of fresh) {
        const entity = fetched[c.qid];
        if (entity) records.set(c.qid, mapWork(entity, c, today));
      }

      // References and link targets: reuse what AMDB already has, fetch the rest once per run.
      const works = [...records.values()].filter((r): r is WorkRecord => !('skip' in r));
      const refQids = works.flatMap((r) => [
        ...r.creators.map((c) => c.qid),
        ...r.series.map((s) => s.qid),
        ...r.franchises,
      ]);
      const linkQids = works.flatMap((r) => r.links.map((l) => l.qid));
      await remember([...new Set([...refQids, ...linkQids])].filter((q) => !known.has(q)));
      // Genres are tags, found by slug rather than QID, so they are always fetched (once per run).
      const toFetch = [...new Set([...refQids, ...works.flatMap((r) => r.genres)])].filter(
        (q) => !known.has(q) && !refEntities.has(q),
      );
      const refs = await fetchEntities(toFetch);
      for (const q of toFetch) refEntities.set(q, refs[q] ?? null);

      for (const [i, c] of batch.entries()) {
        const record = records.get(c.qid);
        if (fresh.every((f) => f.qid !== c.qid)) stats.skipped.present++;
        else if (!record) stats.skipped.missing++;
        else if ('skip' in record) stats.skipped[record.skip]++;
        else await importWork(record);
        stats.stoppedAt = start + i + 1;
      }
      log(`ranks ${start + 1}–${stats.stoppedAt}: ${stats.imported} imported so far`);
    }
    return 'finished' as const;
  }

  /** Final pass: each kept link whose target has since arrived, as a relate-only submission. */
  async function addDeferredLinks() {
    await remember([...new Set(deferred.map((l) => l.toQid))].filter((q) => !known.has(q)));
    for (const link of deferred) {
      const target = known.get(link.toQid);
      if (target?.kind !== 'work') continue;
      try {
        await changes.importSubmission(runId, [
          {
            op: 'relate',
            type: 'work_link',
            from: { id: link.fromId },
            to: { id: target.id },
            data: { linkType: link.linkType },
          },
        ]);
        stats.linksAdded++;
      } catch (err) {
        if (!isItemError(err)) throw err;
        stats.linksFailed++;
        log(`skipped link ${link.fromId} → ${link.toQid}: ${err.code} (${err.message})`);
      }
    }
  }

  const fail = async (err: unknown) => {
    await imports.finishRun(runId, { status: 'failed', stats, error: errorMessage(err) });
  };

  let status: RunStatus;
  let error: string | undefined;
  try {
    status = await importCandidates();
  } catch (err) {
    if (!(err instanceof WikidataUnavailable)) {
      await fail(err);
      throw err;
    }
    // Committed works stay; the run records why it stopped.
    status = 'failed';
    error = err.message;
    log(`failed: ${err.message} (${err.url})`);
  }
  try {
    // Links among works already committed need nothing from Wikidata, so a failed run adds them too.
    await addDeferredLinks();
    stats.bytesEnd = await measure();
    stats.bytesPerWork = stats.imported ? Math.round((stats.bytesEnd - stats.bytesStart) / stats.imported) : 0;
  } catch (err) {
    await fail(err);
    throw err;
  }
  await imports.finishRun(runId, { status, stats, ...(error === undefined ? {} : { error }) });
  return { runId, status, stats };
}
