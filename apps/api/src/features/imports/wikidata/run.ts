// Drives a Wikidata seed import: discover → fetch → map → one revision-logged submission per work.
import { normalizeTitle, type EntityKind, type IdScheme, type WorkLinkType } from '@amdb/shared';
import type { Db } from '../../../platform/db/types';
import { ApiError } from '../../../platform/http/errors';
import type { ChangeInput, EntityRef } from '../../changes/schemas';
import { createChangesService } from '../../changes/service';
import { createImportsService } from '../service';
import { type WikidataClient, type WikidataEntity, WikidataUnavailable } from './client';
import { discover } from './discover';
import { englishLabel, genreTag, mapRef, mapWork, type WorkRecord } from './map';

const LICENSE_URL = 'https://www.wikidata.org/wiki/Wikidata:Licensing';
/** When LICENSE_URL was last read and still said CC0 for the main namespace; re-check and bump it. */
const LICENSE_CHECKED_ON = '2026-11-05';
/** The entity API's per-request cap (the client rejects more). */
const MAX_IDS = 50;

export type SkipReason =
  /** In AMDB already; in a backfill, also a present work an import run didn't create (a person entered it). */
  | 'present'
  /** Backfill only: not in AMDB, and a backfill never imports a work. */
  | 'not_present'
  /** AMDB already holds the QID as a creator, series, property or tag: it isn't turned into a work. */
  | 'held_as_other'
  | 'no_title'
  | 'duplicate_external_id'
  | 'missing'
  | 'invalid';

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
  /** Hand-entered creators, series and properties a submission used (and gave their wikidata id) instead of creating one. */
  refsAdopted: number;
  /** Backfill runs only: imported works that got at least one new relation or external id. */
  backfilled?: number;
  /** Backfill runs only: imported works with nothing missing (or nothing that may be re-added). */
  upToDate?: number;
  /** Backfill runs only: relations added to those works (a new reference's own wikidata id aside). */
  relationsAdded?: number;
  /** Backfill runs only: external ids added to those works. */
  idsAdded?: number;
  /** Backfill runs only: ids a work lacked but another live entity holds (or claimed first), so not added. */
  idsSkippedHeld?: number;
};

export type RunStatus = 'finished' | 'capped' | 'failed';

export interface RunDeps {
  db: Db;
  client: WikidataClient;
  /** Defaults to `pg_database_size` of the current database. */
  measureBytes?: () => Promise<number>;
  today?: Date;
  log?: (line: string) => void;
  /** Aborting stops the run before its next batch or work and finishes it `failed`, "interrupted". */
  signal?: AbortSignal;
}

export interface RunOptions {
  classes: string[];
  minSitelinks: number;
  limit: number;
  maxDbBytes: number;
  batchSize?: number;
  /**
   * Add the references (creators, series, franchises, genres, work links) and external ids that works
   * an import run created are missing, and nothing else: no work is created or edited, and a relation
   * or id scheme that ever existed, live or removed, is never added again.
   */
  backfill?: boolean;
}

type Known = { id: string; kind: EntityKind; live: boolean };
type RefKind = 'creator' | 'series' | 'property';

/** A work link whose target wasn't in AMDB when its work went in. */
interface DeferredLink {
  fromId: string;
  toQid: string;
  linkType: WorkLinkType;
}

/** What a create in a submission stands for, so its returned entity id can be remembered. */
type CreatedKey =
  | { index: number; qid: string; kind: EntityKind }
  | { index: number; slug: string }
  /** A hand-entered reference the submission gave this QID: no create, so no index. */
  | { adopted: string; qid: string; kind: EntityKind; nameKey: string };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A 4xx from planning or applying: about this one item, never the run (a closed run stops it). */
const isItemError = (err: unknown): err is ApiError =>
  err instanceof ApiError && err.status < 500 && err.code !== 'run_not_running';

const INTERRUPTED = 'interrupted';
/** Thrown at a checkpoint once the run's signal has aborted. */
class Interrupted extends Error {
  constructor() {
    super(INTERRUPTED);
  }
}

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
  const checkpoint = () => {
    if (deps.signal?.aborted) throw new Interrupted();
  };

  const { id: runId } = await imports.startRun({
    source: 'wikidata',
    params: { ...opts, batchSize },
    licenseUrl: LICENSE_URL,
    licenseCheckedOn: LICENSE_CHECKED_ON,
  });
  const stats: WikidataImportStats = {
    candidates: 0,
    imported: 0,
    skipped: {
      present: 0,
      not_present: 0,
      held_as_other: 0,
      no_title: 0,
      duplicate_external_id: 0,
      missing: 0,
      invalid: 0,
    },
    linksAdded: 0,
    refsAdopted: 0,
    linksFailed: 0,
    bytesStart: 0,
    bytesEnd: 0,
    bytesPerWork: 0,
    stoppedAt: 0,
    ...(opts.backfill ? { backfilled: 0, upToDate: 0, relationsAdded: 0, idsAdded: 0, idsSkippedHeld: 0 } : {}),
  };

  // Run-local memory: entities by QID (found in AMDB or created by this run), fetched reference
  // items reduced to what planning reads (their mapped fields, and the English label a genre needs;
  // null when Wikidata didn't return one), and genre tags by slug (null for a slug held by a
  // retracted or removed tag, which can't be reused or recreated).
  const known = new Map<string, Known>();
  const refItems = new Map<string, { ref: ReturnType<typeof mapRef>; label: string | null } | null>();
  const tagIds = new Map<string, string | null>();
  const deferred: DeferredLink[] = [];
  /**
   * Every discovered candidate, before `limit`: works win, so none becomes a reference even when this
   * run stops short of it. Includes candidates later skipped (their references are dropped too).
   */
  let candidateQids = new Set<string>();
  /**
   * Reference QIDs whose entity a moderator reverted (its wikidata id, then its create): dropped like a
   * removed one. The QID is no longer held, so `known` can't see it, but recreating it would undo the revert.
   */
  const retiredRefs = new Set<string>();
  /**
   * Hand-entered references (no wikidata id, ever) by `nameKey`: the one entry with that kind and
   * name, which a reference to it adopts (it gets the wikidata id), or null when there are none or
   * several (the run creates its own rather than guess) or one was already adopted. Only nulls carry
   * over between batches: a match is looked up again, in case a person merged or removed it meanwhile.
   */
  const handEntered = new Map<string, string | null>();
  /** QIDs a moderator removed from some entity's wikidata id: never handed to another entry by name. */
  const unadoptable = new Set<string>();
  /** Creators match on their kind too (a person never adopts an organization's entry). */
  const refNameKey = (kind: RefKind, creatorKind: string | null, norm: string) =>
    JSON.stringify(kind === 'creator' ? [kind, creatorKind, norm] : [kind, norm]);
  const nameKey = (kind: RefKind, ref: { name: string; kind: string }) =>
    refNameKey(kind, ref.kind, normalizeTitle(ref.name));

  async function fetchEntities(qids: string[]) {
    const out: Record<string, WikidataEntity> = {};
    for (let i = 0; i < qids.length; i += MAX_IDS)
      Object.assign(out, await deps.client.entities(qids.slice(i, i + MAX_IDS)));
    return out;
  }

  async function remember(qids: string[]) {
    for (const [qid, entity] of await imports.findByWikidataIds(qids)) known.set(qid, entity);
  }

  /**
   * The references a work names, resolved by the run's rules: a create (with its wikidata id) for
   * each new one, and the work's relations to them. `work` is the work's ref in a normal run and its
   * id in a backfill; `offset` is where these creates start in the submission.
   */
  async function referenceChanges(rec: WorkRecord, work: EntityRef, offset: number) {
    const creates: ChangeInput[] = [];
    const relates: ChangeInput[] = [];
    const created: CreatedKey[] = [];
    const local = new Map<string, { ref: EntityRef; kind: RefKind }>();
    const slugs = new Set<string>();

    const nextRef = () => `r${offset + creates.length}`;
    const entityRef = (qid: string, kind: RefKind): EntityRef | null => {
      const found = known.get(qid);
      // Removed, or held as another kind (say, a series item imported as a work): drop the reference,
      // keep the work. A removed entity is never recreated: its wikidata id is still taken.
      if (found) return found.live && found.kind === kind ? { id: found.id } : null;
      if (retiredRefs.has(qid)) return null;
      const already = local.get(qid);
      // One QID in two roles of different kinds (creator and franchise): the first one stands.
      if (already) return already.kind === kind ? already.ref : null;
      const mapped = refItems.get(qid)?.ref ?? null;
      if (!mapped) return null;
      const key = nameKey(kind, mapped);
      const adopted = unadoptable.has(qid) ? null : handEntered.get(key);
      // One entry per QID: a second QID under the same name in this submission gets its own.
      if (adopted && !created.some((c) => 'adopted' in c && c.adopted === adopted)) {
        created.push({ adopted, qid, kind, nameKey: key });
        relates.push({
          op: 'relate',
          type: 'external_id',
          from: { id: adopted },
          data: { scheme: 'wikidata', value: qid },
        });
        local.set(qid, { ref: { id: adopted }, kind });
        return { id: adopted };
      }
      const ref = nextRef();
      const description = mapped.description === undefined ? {} : { description: mapped.description };
      const fields =
        kind === 'creator'
          ? { name: mapped.name, kind: mapped.kind, ...description }
          : { title: mapped.name, ...description };
      created.push({ index: offset + creates.length, qid, kind });
      creates.push({ op: 'create', kind, ref, fields });
      relates.push({ op: 'relate', type: 'external_id', from: { ref }, data: { scheme: 'wikidata', value: qid } });
      local.set(qid, { ref: { ref }, kind });
      return { ref };
    };
    const tagRef = async (qid: string): Promise<EntityRef | null> => {
      const label = refItems.get(qid)?.label;
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
      created.push({ index: offset + creates.length, slug: tag.slug });
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
    return { creates, relates, created };
  }

  /** A work's links to works in AMDB, and the ones whose target isn't in AMDB (yet). */
  function linkChanges(rec: WorkRecord, work: EntityRef) {
    const relates: ChangeInput[] = [];
    const later: Omit<DeferredLink, 'fromId'>[] = [];
    for (const { qid, linkType } of rec.links) {
      if (qid === rec.qid) continue;
      const target = known.get(qid);
      if (!target) later.push({ toQid: qid, linkType });
      // A link is garnish: one to a removed entity or a non-work is dropped, not allowed to sink the work.
      else if (target.live && target.kind === 'work')
        relates.push({ op: 'relate', type: 'work_link', from: work, to: { id: target.id }, data: { linkType } });
    }
    return { relates, later };
  }

  /** One work's submission: its create, creates for new references, its relations and external ids. */
  async function buildChanges(rec: WorkRecord) {
    const work: EntityRef = { ref: 'w' };
    const refs = await referenceChanges(rec, work, 1);
    const ids: ChangeInput[] = rec.externalIds.map(({ scheme, value }) => ({
      op: 'relate',
      type: 'external_id',
      from: work,
      data: { scheme, value },
    }));
    const links = linkChanges(rec, work);
    return {
      changes: [
        { op: 'create', kind: 'work', ref: 'w', fields: rec.fields } satisfies ChangeInput,
        ...refs.creates,
        ...refs.relates,
        ...ids,
        ...links.relates,
      ],
      created: [{ index: 0, qid: rec.qid, kind: 'work' } satisfies CreatedKey, ...refs.created],
      later: links.later,
    };
  }

  /** Remembers what a committed submission created; a failed one rolled back, so it created nothing. */
  function rememberCreated(created: CreatedKey[], result: { changes: { entityId: string | null }[] }) {
    for (const key of created) {
      if ('adopted' in key) {
        known.set(key.qid, { id: key.adopted, kind: key.kind, live: true });
        handEntered.set(key.nameKey, null);
        stats.refsAdopted++;
        log(`adopted hand-entered ${key.kind} ${key.adopted} for ${key.qid}`);
        continue;
      }
      const entityId = result.changes[key.index]?.entityId;
      if (!entityId) throw new Error(`importSubmission returned no entity for change ${key.index + 1}`);
      if ('slug' in key) tagIds.set(key.slug, entityId);
      else known.set(key.qid, { id: entityId, kind: key.kind, live: true });
    }
  }

  async function submitWork(rec: WorkRecord) {
    const built = await buildChanges(rec);
    const result = await changes.importSubmission(runId, built.changes);
    rememberCreated(built.created, result);
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

  /**
   * Relations AMDB holds, live or removed, among the works being backfilled: a backfill never adds one
   * again, so a moderator's unrelate sticks and nothing is duplicated.
   */
  const existingKeys = new Set<string>();
  const relationKey = (
    type: string,
    fromId: string,
    toId: string | null,
    role: string | null,
    linkType: string | null,
  ) => JSON.stringify([type, fromId, toId, role, linkType]);
  /** A relate's key when both its ends are already in AMDB; null when one is created in the same submission. */
  const keyOf = (change: ChangeInput) =>
    change.op === 'relate' && 'id' in change.from && change.to && 'id' in change.to
      ? relationKey(change.type, change.from.id, change.to.id, change.data.role ?? null, change.data.linkType ?? null)
      : null;
  /** Schemes of the external ids each work being backfilled ever had, live or removed. */
  const schemesByWork = new Map<string, Set<IdScheme>>();
  /** `scheme:value` keys held by a live external id: read per batch, then added to as the run submits. */
  const heldIds = new Set<string>();
  const count = (key: 'backfilled' | 'upToDate' | 'relationsAdded' | 'idsAdded' | 'idsSkippedHeld', n = 1) => {
    stats[key] = (stats[key] ?? 0) + n;
  };

  /** Looks up, once per name, the hand-entered entries the batch's new references could adopt. */
  async function findHandEntered(records: WorkRecord[]) {
    const wanted = new Map<RefKind, Map<string, string>>([
      ['creator', new Map()],
      ['series', new Map()],
      ['property', new Map()],
    ]);
    for (const [key, id] of handEntered) if (id !== null) handEntered.delete(key);
    const named: [string, RefKind][] = records.flatMap((r) => [
      ...r.creators.map(({ qid }) => [qid, 'creator'] as [string, RefKind]),
      ...r.series.map(({ qid }) => [qid, 'series'] as [string, RefKind]),
      ...r.franchises.map((qid) => [qid, 'property'] as [string, RefKind]),
    ]);
    const open = named.filter(([qid]) => refItems.get(qid)?.ref && !known.has(qid) && !retiredRefs.has(qid));
    const removed = await imports.findRemovedWikidataIds([...new Set(open.map(([qid]) => qid))]);
    for (const q of removed) unadoptable.add(q);
    for (const [qid, kind] of open) {
      if (unadoptable.has(qid)) continue;
      const mapped = refItems.get(qid)!.ref!;
      const key = nameKey(kind, mapped);
      if (!handEntered.has(key)) wanted.get(kind)!.set(key, normalizeTitle(mapped.name));
    }
    for (const [kind, keys] of wanted) {
      if (keys.size === 0) continue;
      const rows = await imports.findUnlinkedByName(kind, [...new Set(keys.values())]);
      const ids = new Map<string, string[]>();
      for (const row of rows) {
        const key = refNameKey(kind, row.creatorKind, row.norm);
        ids.set(key, [...(ids.get(key) ?? []), row.id]);
      }
      for (const key of keys.keys()) {
        const found = ids.get(key) ?? [];
        handEntered.set(key, found.length === 1 ? found[0]! : null);
      }
    }
  }

  /** Adds what an imported work is missing, as one relate-only submission (plus creates for new references). */
  async function backfillWork(rec: WorkRecord, workId: string) {
    const work: EntityRef = { id: workId };
    const refs = await referenceChanges(rec, work, 0);
    // A link whose target isn't in AMDB stays missing: a backfill brings in no work, so none can arrive.
    const links = linkChanges(rec, work);
    const keys = new Set<string>();
    // Only relates between existing entities can be filtered out, so every create keeps its relation
    // and `refs.created`'s indices (the creates come first) still hold.
    const relates = [...refs.relates, ...links.relates].filter((change) => {
      const key = keyOf(change);
      if (key === null) return true;
      if (existingKeys.has(key) || keys.has(key)) return false;
      keys.add(key);
      return true;
    });
    const added = relates.filter((c) => c.op === 'relate' && c.type !== 'external_id').length;

    // The work's own ids it never had (a removed one counts as had) and nobody else holds.
    const had = schemesByWork.get(workId) ?? new Set<IdScheme>();
    const newIds: { scheme: IdScheme; value: string }[] = [];
    for (const id of rec.externalIds) {
      if (id.scheme === 'wikidata' || had.has(id.scheme)) continue;
      if (heldIds.has(`${id.scheme}:${id.value}`)) count('idsSkippedHeld');
      else newIds.push(id);
    }
    const idChanges = (ids: typeof newIds): ChangeInput[] =>
      ids.map(({ scheme, value }) => ({ op: 'relate', type: 'external_id', from: work, data: { scheme, value } }));

    let ids = newIds;
    for (let retried = false; ; retried = true) {
      if (added === 0 && ids.length === 0) {
        count('upToDate');
        return;
      }
      try {
        const result = await changes.importSubmission(runId, [...refs.creates, ...relates, ...idChanges(ids)]);
        rememberCreated(refs.created, result);
        break;
      } catch (err) {
        if (!isItemError(err)) throw err;
        if (err.code === 'duplicate_external_id' && !retried && ids.length > 0) {
          // Raced with another holder of one of the ids: keep the rest of the submission.
          count('idsSkippedHeld', ids.length);
          ids = [];
          continue;
        }
        stats.skipped.invalid++;
        log(`skipped ${rec.qid}: ${err.code} (${err.message})`);
        return;
      }
    }
    for (const key of keys) existingKeys.add(key);
    for (const { scheme, value } of ids) heldIds.add(`${scheme}:${value}`);
    count('backfilled');
    count('relationsAdded', added);
    count('idsAdded', ids.length);
  }

  async function importCandidates() {
    stats.bytesStart = await measure();
    const discovered = await discover(deps.client, opts);
    candidateQids = new Set(discovered.map((c) => c.qid));
    const candidates = discovered.slice(0, opts.limit);
    stats.candidates = candidates.length;
    log(`${candidates.length} candidates`);
    checkpoint();

    for (let start = 0; start < candidates.length; start += batchSize) {
      const bytes = await measure();
      if (bytes >= opts.maxDbBytes) {
        log(`capped at ${bytes} bytes before rank ${start + 1}`);
        return 'capped' as const;
      }
      checkpoint();
      const batch = candidates.slice(start, start + batchSize);
      await remember(batch.map((c) => c.qid));
      // A reverted work loses its live wikidata id, so `known` can't see it; it still counts as present.
      const retired = await imports.findRetiredWikidataIds(batch.map((c) => c.qid).filter((q) => !known.has(q)));
      const fresh = batch.filter((c) => !known.has(c.qid) && !retired.has(c.qid));
      // A backfill maps the works an import run created instead; merged-away and person-entered ones aren't among them.
      const imported = opts.backfill
        ? await imports.findImportedWorks(batch.map((c) => c.qid).filter((q) => known.get(q)?.kind === 'work'))
        : new Map<string, string>();
      const toMap = opts.backfill ? batch.filter((c) => imported.has(c.qid)) : fresh;
      const fetched = await fetchEntities(toMap.map((c) => c.qid));
      const records = new Map<string, WorkRecord | { skip: 'no_title' }>();
      for (const c of toMap) {
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
      const unchecked = [...new Set(refQids)].filter((q) => !known.has(q) && !refItems.has(q) && !retiredRefs.has(q));
      for (const q of await imports.findRetiredWikidataIds(unchecked)) retiredRefs.add(q);
      // Genres are tags, found by slug rather than QID, so they are always fetched (once per run).
      // Works win: a candidate is never fetched as a reference, so it has no mapping and `entityRef`
      // drops it; a later candidate becomes a work, so it can't also be created as a reference.
      const toFetch = [...new Set([...refQids, ...works.flatMap((r) => r.genres)])].filter(
        (q) => !known.has(q) && !refItems.has(q) && !candidateQids.has(q) && !retiredRefs.has(q),
      );
      const refs = await fetchEntities(toFetch);
      for (const q of toFetch) {
        const entity = refs[q];
        refItems.set(q, entity ? { ref: mapRef(entity), label: englishLabel(entity) || null } : null);
      }
      await findHandEntered(works);
      for (const r of await imports.findRelationKeys([...imported.values()]))
        existingKeys.add(relationKey(r.type, r.fromId, r.toId, r.role, r.linkType));
      if (opts.backfill) {
        for (const [id, schemes] of await imports.findExternalIdSchemes([...imported.values()]))
          schemesByWork.set(id, schemes);
        const wanted = works
          .filter((r) => imported.has(r.qid))
          .flatMap((r) => r.externalIds.filter((e) => e.scheme !== 'wikidata'));
        for (const key of await imports.findHeldExternalIds(wanted)) heldIds.add(key);
      }

      for (const [i, c] of batch.entries()) {
        checkpoint();
        const record = records.get(c.qid);
        const held = known.get(c.qid);
        // A removed holder of any kind counts as present: a removal must stick.
        if (held?.live && held.kind !== 'work') {
          stats.skipped.held_as_other++;
          log(`skipped ${c.qid}: held as a ${held.kind}`);
        } else if (opts.backfill) {
          const workId = imported.get(c.qid);
          if (!held && !retired.has(c.qid)) stats.skipped.not_present++;
          else if (!workId) stats.skipped.present++;
          else if (!record) stats.skipped.missing++;
          else if ('skip' in record) stats.skipped[record.skip]++;
          else await backfillWork(record, workId);
        } else if (fresh.every((f) => f.qid !== c.qid)) stats.skipped.present++;
        else if (!record) stats.skipped.missing++;
        else if ('skip' in record) stats.skipped[record.skip]++;
        else await importWork(record);
        stats.stoppedAt = start + i + 1;
      }
      const done = opts.backfill ? `${stats.backfilled ?? 0} backfilled` : `${stats.imported} imported`;
      log(`ranks ${start + 1}–${stats.stoppedAt}: ${done} so far`);
    }
    return 'finished' as const;
  }

  /** Final pass: each kept link whose target has since arrived, as a relate-only submission. */
  async function addDeferredLinks() {
    await remember([...new Set(deferred.map((l) => l.toQid))].filter((q) => !known.has(q)));
    for (const link of deferred) {
      // An interrupted run stops here too; the links it didn't add are just missing.
      if (deps.signal?.aborted) return;
      const target = known.get(link.toQid);
      if (!target?.live || target.kind !== 'work') continue;
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
    // The run page is public: an unexpected error's text (SQL, paths) goes to the operator's log only.
    const reportable = err instanceof ApiError || err instanceof WikidataUnavailable;
    if (!reportable)
      log(`internal error in run ${runId}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    try {
      await imports.finishRun(runId, {
        status: 'failed',
        stats,
        error: reportable ? errorMessage(err) : "internal error (see the importer's log)",
      });
    } catch (finishErr) {
      // Not swallowed: the caller rethrows `err`, the error that actually stopped the run.
      log(`could not record the failure of run ${runId}: ${errorMessage(finishErr)}`);
    }
  };

  let status: RunStatus;
  let error: string | undefined;
  try {
    status = await importCandidates();
  } catch (err) {
    // Committed works stay; the run records why it stopped.
    if (err instanceof Interrupted) {
      status = 'failed';
      error = INTERRUPTED;
    } else if (err instanceof WikidataUnavailable) {
      status = 'failed';
      error = err.message;
      log(`failed: ${err.message} (${err.url})`);
    } else {
      await fail(err);
      throw err;
    }
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
  if (deps.signal?.aborted && status !== 'failed') {
    status = 'failed';
    error = INTERRUPTED;
  }
  if (error === INTERRUPTED) log('interrupted');
  await imports.finishRun(runId, { status, stats, ...(error === undefined ? {} : { error }) });
  return { runId, status, stats };
}
