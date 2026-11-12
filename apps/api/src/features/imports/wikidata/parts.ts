// Imports the seasons and episodes of shows AMDB holds: discover → fetch → map → place → one submission per season.
import { isPartSubtype, normalizeTitle } from '@amdb/shared';
import type { Db } from '../../../platform/db/types';
import type { ApiError } from '../../../platform/http/errors';
import type { ChangeInput, EntityRef } from '../../changes/schemas';
import type { ChangesService } from '../../changes/service';
import { createImportsService, type ImportsService } from '../service';
import { type SparqlRow, type WikidataClient, type WikidataEntity, WikidataUnavailable } from './client';
import { mapPart, type PartRecord } from './map';
import { placeEpisodes, seasonNumber } from './tree';

/** Wikidata's base classes; their `P279*` subclasses (anime episodes, say) are found too. */
export const SEASON_CLASS = 'Q3464665';
export const EPISODE_CLASS = 'Q21191270';
/** Shows per parts query, and QIDs per entity request (the client's cap). */
const BATCH = 50;
/** Episodes directly under a show, per submission: `importSubmission` has no change cap, so this keeps one transaction small. */
const EPISODES_PER_SUBMISSION = 25;

type PartSubtype = 'season' | 'episode';

export type PartSkipReason = 'no_title' | 'held_as_other' | 'reverted' | 'invalid' | 'missing';

/** What a `--parts` run counts, besides `candidates` (shows considered), `stoppedAt` and the bytes. */
export interface PartsStats {
  /** Shows Wikidata lists at least one season or episode for. */
  shows: number;
  /** Seasons and episodes discovered, each once per show. */
  partsFound: number;
  /** `partsFound` by the item's class: the base class when listed, else its lowest-numbered subclass. */
  partsByClass: Record<string, number>;
  partsAdded: number;
  /** Already in AMDB as a part (never moved), or held by a removed entry (a removal sticks). */
  partsPresent: number;
  /** Hand-entered parts that got their wikidata id instead of being created again. */
  partsAdopted: number;
  /** Held as a live work that isn't a part (a movie, a series): never turned into one. */
  partsHeldAsRoot: number;
  /** Episodes with no season or show to hang under that Wikidata doesn't contradict. */
  partsUnplaced: number;
  partsSkipped: Record<PartSkipReason, number>;
  /** Credits to a creator AMDB doesn't hold live: never created, so not added. */
  creditsSkipped: number;
  bytesPerPart: number;
}

export const newPartsStats = (): PartsStats => ({
  shows: 0,
  partsFound: 0,
  partsByClass: {},
  partsAdded: 0,
  partsPresent: 0,
  partsAdopted: 0,
  partsHeldAsRoot: 0,
  partsUnplaced: 0,
  partsSkipped: { no_title: 0, held_as_other: 0, reverted: 0, invalid: 0, missing: 0 },
  creditsSkipped: 0,
  bytesPerPart: 0,
});

// --- Discovery ---

export interface DiscoveredPart {
  qid: string;
  showQid: string;
  subtype: PartSubtype;
  cls: string;
}

const qidOf = (uri: string | undefined) => {
  const qid = uri?.split('/').pop() ?? '';
  return /^Q\d+$/.test(qid) ? qid : null;
};
const qidNumber = (qid: string) => Number(qid.slice(1));

const partsQuery = (base: string, showQids: string[]) =>
  `SELECT ?item ?show ?cls WHERE { VALUES ?show { ${showQids.map((q) => `wd:${q}`).join(' ')} } ?item wdt:P179 ?show; wdt:P31 ?cls. ?cls wdt:P279* wd:${base} }`;

/** One class's parts of these shows; a batch Wikidata can't answer is asked again one show at a time. */
async function askParts(client: WikidataClient, base: string, showQids: string[]): Promise<SparqlRow[]> {
  if (showQids.length > 1) {
    try {
      return await client.sparql(partsQuery(base, showQids));
    } catch (err) {
      if (!(err instanceof WikidataUnavailable)) throw err;
    }
  }
  const rows: SparqlRow[] = [];
  for (const q of showQids) {
    try {
      rows.push(...(await client.sparql(partsQuery(base, [q]))));
    } catch (err) {
      // Name the class and show so the operator knows which query failed.
      if (err instanceof WikidataUnavailable)
        throw new WikidataUnavailable(`${base} parts of ${q}: ${err.message}`, err.status, err.url);
      throw err;
    }
  }
  return rows;
}

/**
 * The seasons and episodes Wikidata lists (`P179`) under these shows, subclasses included. An item in
 * both trees is a season; one listed under two shows is found once for each.
 */
export async function discoverParts(client: WikidataClient, showQids: string[]): Promise<DiscoveredPart[]> {
  const out: DiscoveredPart[] = [];
  for (let i = 0; i < showQids.length; i += BATCH) {
    const batch = showQids.slice(i, i + BATCH);
    const found = new Map<string, { qid: string; showQid: string; subtype: PartSubtype; classes: Set<string> }>();
    // Serial: the client is serial by contract. Seasons first, so an item in both trees stays a season.
    for (const [subtype, base] of [
      ['season', SEASON_CLASS],
      ['episode', EPISODE_CLASS],
    ] as const) {
      for (const row of await askParts(client, base, batch)) {
        const qid = qidOf(row.item);
        const showQid = qidOf(row.show);
        const cls = qidOf(row.cls);
        if (!qid || !showQid || !cls || !batch.includes(showQid)) continue;
        const key = `${showQid} ${qid}`;
        const entry = found.get(key);
        if (!entry) found.set(key, { qid, showQid, subtype, classes: new Set([cls]) });
        else if (entry.subtype === subtype) entry.classes.add(cls);
      }
    }
    for (const { classes, ...part } of found.values()) {
      const base = part.subtype === 'season' ? SEASON_CLASS : EPISODE_CLASS;
      const [lowest] = [...classes].toSorted((a, b) => qidNumber(a) - qidNumber(b));
      out.push({ ...part, cls: classes.has(base) ? base : (lowest ?? base) });
    }
  }
  return out;
}

// --- Planning one show (read-only) ---

/** A part this run writes: created, or a hand-entered one given its wikidata id (no other change). */
type NewPart =
  | {
      kind: 'create';
      qid: string;
      rec: PartRecord;
      position: number | null;
      credits: { creatorId: string; role: string }[];
      /** Credits to creators AMDB doesn't hold live. */
      creditsSkipped: number;
    }
  | { kind: 'adopt'; qid: string; id: string };

/** One submission: a season (new, adopted or already in AMDB) and its new episodes, or a run of episodes under the show. */
interface Group {
  /** The season's QID, or the show's for episodes directly under it. */
  label: string;
  /** Null for episodes directly under the show. */
  season: NewPart | { kind: 'present'; id: string } | null;
  episodes: NewPart[];
}

interface ShowPlan {
  groups: Group[];
  present: number;
  heldAsRoot: number;
  unplaced: number;
  skipped: Omit<Record<PartSkipReason, number>, 'invalid'>;
}

type Reads = Pick<
  ImportsService,
  'findHeldParts' | 'findRetiredWikidataIds' | 'findPartsOf' | 'findRemovedWikidataIds' | 'findByWikidataIds'
>;

interface PlanEnv {
  client: WikidataClient;
  imports: Reads;
  today: Date;
}

/** Numbered first, by number, then by QID number: the order a run submits in. */
const inOrder = <P extends { qid: string; position: number | null }>(parts: P[]) =>
  parts.toSorted((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || qidNumber(a.qid) - qidNumber(b.qid));

/**
 * What a run would write for one show, reading AMDB and Wikidata only: each discovered part is
 * classified (present, held as a root or another kind, reverted, missing, untitled, or new), the new
 * seasons are numbered under the show and the new episodes placed, and hand-entered parts are matched.
 */
async function planShow(env: PlanEnv, show: { id: string; qid: string }, discovered: DiscoveredPart[]) {
  const { imports } = env;
  const plan: ShowPlan = {
    groups: [],
    present: 0,
    heldAsRoot: 0,
    unplaced: 0,
    skipped: { no_title: 0, held_as_other: 0, reverted: 0, missing: 0 },
  };
  const qids = discovered.map((p) => p.qid);
  const held = await imports.findHeldParts(qids);
  const retired = await imports.findRetiredWikidataIds(qids.filter((q) => !held.has(q)));
  const open = discovered.filter((p) => !held.has(p.qid) && !retired.has(p.qid));
  // Every season, present ones included (their P527 lists episodes), and the episodes that may be new.
  const toFetch = [show.qid, ...discovered.filter((p) => p.subtype === 'season').map((p) => p.qid)];
  for (const p of open) if (p.subtype === 'episode') toFetch.push(p.qid);
  const fetched: Record<string, WikidataEntity> = {};
  for (let i = 0; i < toFetch.length; i += BATCH)
    Object.assign(fetched, await env.client.entities(toFetch.slice(i, i + BATCH)));

  const placedSeasons = new Map<string, NewPart | { kind: 'present'; id: string }>();
  const newRecords = new Map<string, PartRecord>();
  for (const p of discovered) {
    const h = held.get(p.qid);
    if (h) {
      // A removed holder of any kind counts as present: a removal must stick.
      if (!h.live) plan.present++;
      else if (h.kind !== 'work') plan.skipped.held_as_other++;
      else if (!isPartSubtype(h.subtype)) plan.heldAsRoot++;
      else {
        plan.present++;
        // Never moved: a present season takes new episodes only where it already hangs under this show.
        if (p.subtype === 'season' && h.subtype === 'season' && h.parentId === show.id)
          placedSeasons.set(p.qid, { kind: 'present', id: h.id });
      }
      continue;
    }
    if (retired.has(p.qid)) {
      plan.skipped.reverted++;
      continue;
    }
    const entity = fetched[p.qid];
    if (!entity) {
      plan.skipped.missing++;
      continue;
    }
    const rec = mapPart(entity, p.subtype, env.today);
    if ('skip' in rec) plan.skipped[rec.skip]++;
    else newRecords.set(p.qid, rec);
  }

  // Hand-entered parts (no wikidata id, ever) under the show and its seasons, by parent.
  const underShow = await imports.findPartsOf([show.id]);
  const underSeasons = await imports.findPartsOf(underShow.filter((r) => r.subtype === 'season').map((r) => r.id));
  const handEntered = [...underShow, ...underSeasons].filter((r) => !r.everHadWikidataId);
  const unadoptable = await imports.findRemovedWikidataIds([...newRecords.keys()]);
  const adopted = new Set<string>();
  /** The one hand-entered part under `parentId` this one matches: same subtype and number, else (unnumbered) same title. */
  const adoptable = (parentId: string, subtype: PartSubtype, rec: PartRecord, position: number | null) => {
    if (unadoptable.has(rec.qid)) return null;
    const norm = normalizeTitle(rec.fields.title);
    const matches = handEntered.filter(
      (r) =>
        r.parentId === parentId &&
        r.subtype === subtype &&
        !adopted.has(r.id) &&
        (position === null ? r.titleNorm === norm : r.position === position),
    );
    const [only] = matches;
    if (matches.length !== 1 || !only) return null;
    adopted.add(only.id);
    return only.id;
  };

  const creatorQids = [...newRecords.values()].flatMap((r) => r.creators.map((c) => c.qid));
  const creators = new Map<string, string>();
  for (const [qid, e] of await imports.findByWikidataIds([...new Set(creatorQids)]))
    if (e.live && e.kind === 'creator') creators.set(qid, e.id);
  /** A new part under `parentId`: adopted when it matches a hand-entered one there, else created with the credits AMDB can give. */
  const newPart = (
    parentId: string | null,
    rec: PartRecord,
    subtype: PartSubtype,
    position: number | null,
  ): NewPart => {
    const id = parentId === null ? null : adoptable(parentId, subtype, rec, position);
    if (id) return { kind: 'adopt', qid: rec.qid, id };
    const credits = rec.creators.flatMap(({ qid, role }) => {
      const creatorId = creators.get(qid);
      return creatorId ? [{ creatorId, role }] : [];
    });
    return {
      kind: 'create',
      qid: rec.qid,
      rec,
      position,
      credits,
      creditsSkipped: rec.creators.length - credits.length,
    };
  };

  const showEntity = fetched[show.qid];
  const seasonsOfShow = new Map<string, WikidataEntity>();
  for (const p of discovered) {
    const entity = fetched[p.qid];
    if (p.subtype === 'season' && entity) seasonsOfShow.set(p.qid, entity);
  }
  /** Wikidata's number for each season of the show: where a new one goes, and the order seasons are sent in. */
  const seasonNumbers = new Map<string, number | null>();
  for (const [qid, entity] of seasonsOfShow) seasonNumbers.set(qid, seasonNumber(entity, show.qid, showEntity));
  for (const [qid, rec] of newRecords)
    if (seasonsOfShow.has(qid)) placedSeasons.set(qid, newPart(show.id, rec, 'season', seasonNumbers.get(qid) ?? null));

  const placement = placeEpisodes({
    showQid: show.qid,
    seasonsOfShow,
    placedSeasons: new Set(placedSeasons.keys()),
    showHasSeasonParts: underShow.some((r) => r.subtype === 'season'),
    episodes: discovered.flatMap((p) => {
      const entity = fetched[p.qid];
      return p.subtype === 'episode' && newRecords.has(p.qid) && entity ? [entity] : [];
    }),
  });
  plan.unplaced = placement.unplaced.length;

  const bySeason = new Map<string, { qid: string; position: number | null; part: NewPart }[]>();
  const direct: { qid: string; position: number | null; part: NewPart }[] = [];
  for (const { qid, parentQid, position } of placement.placed) {
    const rec = newRecords.get(qid);
    if (!rec) continue;
    if (parentQid === show.qid) {
      direct.push({ qid, position, part: newPart(show.id, rec, 'episode', position) });
      continue;
    }
    const season = placedSeasons.get(parentQid);
    // A season created in this submission has no hand-entered episodes to adopt.
    const parentId = season && season.kind !== 'create' ? season.id : null;
    const placed = { qid, position, part: newPart(parentId, rec, 'episode', position) };
    bySeason.set(parentQid, [...(bySeason.get(parentQid) ?? []), placed]);
  }

  const seasons = [...placedSeasons].map(([qid, season]) => ({
    qid,
    season,
    position: seasonNumbers.get(qid) ?? null,
  }));
  for (const { qid, season } of inOrder(seasons)) {
    const episodes = inOrder(bySeason.get(qid) ?? []).map((e) => e.part);
    // A season already in AMDB with no new episodes has nothing to send.
    if (season.kind !== 'present' || episodes.length > 0) plan.groups.push({ label: qid, season, episodes });
  }
  const directInOrder = inOrder(direct).map((e) => e.part);
  for (let i = 0; i < directInOrder.length; i += EPISODES_PER_SUBMISSION)
    plan.groups.push({ label: show.qid, season: null, episodes: directInOrder.slice(i, i + EPISODES_PER_SUBMISSION) });
  return plan;
}

/** The parts a group writes (created or adopted), the season first. */
const partsOf = (group: Group): NewPart[] =>
  group.season && group.season.kind !== 'present' ? [group.season, ...group.episodes] : group.episodes;

const creditsSkippedOf = (group: Group) =>
  partsOf(group).reduce((n, p) => n + (p.kind === 'create' ? p.creditsSkipped : 0), 0);

/** Adds a show's discovered parts to `partsFound` and `partsByClass`, and the show to `shows` when it has any. */
function countFound(stats: Pick<PartsStats, 'shows' | 'partsFound' | 'partsByClass'>, discovered: DiscoveredPart[]) {
  if (discovered.length > 0) stats.shows++;
  stats.partsFound += discovered.length;
  for (const { cls } of discovered) stats.partsByClass[cls] = (stats.partsByClass[cls] ?? 0) + 1;
}

/**
 * A group's changes: the season's create and its `work_part` from the show (or, adopted, only its
 * wikidata id), then each new episode's create, `work_part` from the season, ids and credits.
 * `wikidataOnly` keeps only the `wikidata` external ids.
 */
function buildChanges(group: Group, showId: string, wikidataOnly: boolean): ChangeInput[] {
  const out: ChangeInput[] = [];
  const add = (part: NewPart, parent: EntityRef): EntityRef => {
    if (part.kind === 'adopt') {
      const work = { id: part.id };
      out.push({ op: 'relate', type: 'external_id', from: work, data: { scheme: 'wikidata', value: part.qid } });
      return work;
    }
    const work = { ref: `p${out.length}` };
    out.push({ op: 'create', kind: 'work', ref: work.ref, fields: part.rec.fields });
    out.push({
      op: 'relate',
      type: 'work_part',
      from: parent,
      to: work,
      data: part.position === null ? {} : { position: part.position },
    });
    for (const { scheme, value } of part.rec.externalIds)
      if (!wikidataOnly || scheme === 'wikidata')
        out.push({ op: 'relate', type: 'external_id', from: work, data: { scheme, value } });
    for (const { creatorId, role } of part.credits)
      out.push({ op: 'relate', type: 'work_creator', from: work, to: { id: creatorId }, data: { role } });
    return work;
  };
  const show = { id: showId };
  const season = group.season;
  const parent = season === null ? show : season.kind === 'present' ? { id: season.id } : add(season, show);
  for (const e of group.episodes) add(e, parent);
  return out;
}

// --- The run body and the dry run ---

export interface PartsRunContext {
  client: WikidataClient;
  imports: ImportsService;
  changes: ChangesService;
  runId: string;
  stats: PartsStats & { candidates: number; stoppedAt: number; bytesStart: number };
  limit: number;
  maxDbBytes: number;
  today: Date;
  log: (line: string) => void;
  measure: () => Promise<number>;
  /** Throws once the run's signal has aborted. */
  checkpoint: () => void;
  /** A 4xx about this one submission, never the run. */
  isItemError: (err: unknown) => err is ApiError;
}

/** A `--parts` run: every season and episode Wikidata has for the shows AMDB holds, one submission per season. */
export async function importParts(ctx: PartsRunContext): Promise<'finished' | 'capped'> {
  const { stats, log } = ctx;
  stats.bytesStart = await ctx.measure();
  const shows = await ctx.imports.findShows(ctx.limit);
  stats.candidates = shows.length;
  log(`${shows.length} shows`);

  /** Sends one group, retried once with only wikidata ids on `duplicate_external_id`; any other item error skips it. */
  async function submit(group: Group, showId: string) {
    const parts = partsOf(group);
    for (let retried = false; ; retried = true) {
      try {
        await ctx.changes.importSubmission(ctx.runId, buildChanges(group, showId, retried));
        break;
      } catch (err) {
        if (!ctx.isItemError(err)) throw err;
        // Another entry already holds one of the ids (say, a shared IMDb id): keep the parts, drop the rest.
        if (err.code === 'duplicate_external_id' && !retried) continue;
        stats.partsSkipped.invalid += parts.length;
        log(`skipped parts of ${group.label}: ${err.code} (${err.message})`);
        return;
      }
    }
    for (const p of parts) {
      if (p.kind === 'create') stats.partsAdded++;
      else {
        stats.partsAdopted++;
        log(`adopted hand-entered part ${p.id} for ${p.qid}`);
      }
    }
    stats.creditsSkipped += creditsSkippedOf(group);
  }

  const env: PlanEnv = { client: ctx.client, imports: ctx.imports, today: ctx.today };
  for (let start = 0; start < shows.length; start += BATCH) {
    ctx.checkpoint();
    const batch = shows.slice(start, start + BATCH);
    const discovered = await discoverParts(
      ctx.client,
      batch.map((s) => s.qid),
    );
    for (const [i, show] of batch.entries()) {
      ctx.checkpoint();
      const mine = discovered.filter((p) => p.showQid === show.qid);
      countFound(stats, mine);
      const plan = await planShow(env, show, mine);
      stats.partsPresent += plan.present;
      stats.partsHeldAsRoot += plan.heldAsRoot;
      stats.partsUnplaced += plan.unplaced;
      for (const reason of ['no_title', 'held_as_other', 'reverted', 'missing'] as const)
        stats.partsSkipped[reason] += plan.skipped[reason];
      for (const group of plan.groups) {
        // Between submissions, so no episode lands without its season and show.
        const bytes = await ctx.measure();
        if (bytes >= ctx.maxDbBytes) {
          log(`capped at ${bytes} bytes before ${group.label}`);
          return 'capped';
        }
        ctx.checkpoint();
        await submit(group, show.id);
      }
      stats.stoppedAt = start + i + 1;
    }
    log(`shows ${start + 1}–${stats.stoppedAt}: ${stats.partsAdded} parts added so far`);
  }
  return 'finished';
}

/** What `--parts --dry-run` prints besides its flags. */
export interface PartsPreview {
  shows: number;
  partsFound: number;
  partsByClass: Record<string, number>;
  /** Parts a run would add or adopt now. */
  placed: number;
  partsUnplaced: number;
  partsHeldAsRoot: number;
  creditsSkipped: number;
}

/**
 * `--parts --dry-run`: discovers, fetches, maps and places the parts of the first `limit` shows as a
 * run would, reading the database only (no import run is started), and counts the outcome.
 */
export async function previewParts(
  deps: { db: Db; client: WikidataClient; today?: Date; log?: (line: string) => void },
  opts: { limit: number },
): Promise<PartsPreview> {
  const imports = createImportsService(deps.db);
  const env: PlanEnv = { client: deps.client, imports, today: deps.today ?? new Date() };
  const out: PartsPreview = {
    shows: 0,
    partsFound: 0,
    partsByClass: {},
    placed: 0,
    partsUnplaced: 0,
    partsHeldAsRoot: 0,
    creditsSkipped: 0,
  };
  const shows = await imports.findShows(opts.limit);
  deps.log?.(`${shows.length} shows`);
  for (let start = 0; start < shows.length; start += BATCH) {
    const batch = shows.slice(start, start + BATCH);
    const discovered = await discoverParts(
      deps.client,
      batch.map((s) => s.qid),
    );
    for (const show of batch) {
      const mine = discovered.filter((p) => p.showQid === show.qid);
      countFound(out, mine);
      const plan = await planShow(env, show, mine);
      out.partsUnplaced += plan.unplaced;
      out.partsHeldAsRoot += plan.heldAsRoot;
      for (const group of plan.groups) {
        out.placed += partsOf(group).length;
        out.creditsSkipped += creditsSkippedOf(group);
      }
    }
  }
  return out;
}
