import { and, count, eq, isNull } from 'drizzle-orm';
import { expect, it } from 'vitest';
import type { WikidataEntity } from '../src/features/imports/wikidata/client.js';
import { previewParts } from '../src/features/imports/wikidata/parts.js';
import { runWikidataImport } from '../src/features/imports/wikidata/run.js';
import {
  changes as changesTable,
  creators,
  importRuns,
  relations,
  series,
  submissions,
  works,
} from '../src/platform/db/schema';
import { publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';
import { claim, fakeWikidata, item, person } from './helpers/wikidata';

type T = Awaited<ReturnType<typeof setupTest>>;

const SHOW_CLASS = 'Q5398426';
const SEASON_CLASS = 'Q3464665';
const EPISODE_CLASS = 'Q21191270';
const TODAY = new Date('2026-11-12T12:00:00Z');
const MAX = Number.MAX_SAFE_INTEGER;
const SHOWS = { classes: [SHOW_CLASS], minSitelinks: 0, limit: 100, maxDbBytes: MAX };
const PARTS = { ...SHOWS, parts: true };
const bytes = () => async () => 1000;
const uri = (qid: string) => `http://www.wikidata.org/entity/${qid}`;

// --- Fixtures, in the wbgetentities shape ---

/** Built to the WikidataEntity shape; claims are loosely typed here to keep the fixtures short. */
const entity = (id: string, title: string, claims: Record<string, unknown[]>) =>
  ({ id, labels: { en: { value: title } }, claims }) as WikidataEntity;

const show = (id: string, title: string, director?: string) =>
  entity(id, title, director ? { P57: [claim('P57', item(director))] } : {});

/** A season: P179 → its show with the season number, P527 listing its episodes. */
const season = (id: string, title: string, showQid: string, ordinal?: string, episodes: [string, string][] = []) =>
  entity(id, title, {
    P179: [claim('P179', item(showQid), ordinal)],
    ...(episodes.length ? { P527: episodes.map(([qid, n]) => claim('P527', item(qid), n)) } : {}),
  });

interface EpisodeSpec {
  showQid: string;
  /** P4908 season, with the episode's number in it. */
  season?: [string, string];
  /** The episode's overall number (on its P179 claim). */
  overall?: string;
  director?: string;
  writer?: string;
  imdb?: string;
  follows?: string;
}
const episode = (id: string, title: string, spec: EpisodeSpec) =>
  entity(id, title, {
    P179: [claim('P179', item(spec.showQid), spec.overall)],
    ...(spec.season ? { P4908: [claim('P4908', item(spec.season[0]), spec.season[1])] } : {}),
    ...(spec.director ? { P57: [claim('P57', item(spec.director))] } : {}),
    ...(spec.writer ? { P58: [claim('P58', item(spec.writer))] } : {}),
    ...(spec.imdb ? { P345: [claim('P345', spec.imdb)] } : {}),
    ...(spec.follows ? { P155: [claim('P155', item(spec.follows))] } : {}),
  });

interface World {
  shows: string[];
  seasons: { qid: string; show: string; cls?: string }[];
  episodes: { qid: string; show: string; cls?: string }[];
  entities: Record<string, WikidataEntity>;
}

/** The QIDs a query's `VALUES ?show { … }` asks about. */
const askedShows = (query: string) =>
  [...(/VALUES \?show \{([^}]*)\}/.exec(query)?.[1] ?? '').matchAll(/wd:(Q\d+)/g)].map((m) => m[1]);

/**
 * Answers the show discovery (`wikibase:sitelinks`, for the shows' normal run) and the parts queries.
 * `failMulti` makes a parts query about more than one show answer 504.
 */
function wikidataFor(world: World, { failMulti = false } = {}) {
  return fakeWikidata([], world.entities, () => false, {
    sparql: (query) => {
      if (query.includes('wikibase:sitelinks'))
        return query.includes(`wd:${SHOW_CLASS}`) ? world.shows.map((q) => ({ item: uri(q), sl: '10' })) : [];
      const asked = askedShows(query);
      if (failMulti && asked.length > 1) return new Response('', { status: 504 });
      const [list, base] = query.includes(`wd:${SEASON_CLASS}`)
        ? [world.seasons, SEASON_CLASS]
        : [world.episodes, EPISODE_CLASS];
      return list
        .filter((p) => asked.includes(p.show))
        .map((p) => ({ item: uri(p.qid), show: uri(p.show), cls: uri(p.cls ?? base) }));
    },
  });
}

/**
 * Show Q1 "The Show" (directed by Q900) with Season 1 (Q11: Pilot Q101, Second Q102) and Season 2
 * (Q12: Third Q201). The pilot's director Q900 is a creator once the show is imported; its writer
 * Q901 never is. Each episode follows the one before it (P155).
 */
function baseWorld(): World {
  return {
    shows: ['Q1'],
    seasons: [
      { qid: 'Q11', show: 'Q1' },
      { qid: 'Q12', show: 'Q1' },
    ],
    episodes: [
      { qid: 'Q101', show: 'Q1' },
      { qid: 'Q102', show: 'Q1' },
      { qid: 'Q201', show: 'Q1' },
    ],
    entities: {
      Q1: show('Q1', 'The Show', 'Q900'),
      Q900: person('Q900', 'Dana Director'),
      Q901: person('Q901', 'Wendy Writer'),
      Q11: season('Q11', 'Season 1', 'Q1', '1', [
        ['Q101', '1'],
        ['Q102', '2'],
      ]),
      Q12: season('Q12', 'Season 2', 'Q1', '2'),
      Q101: episode('Q101', 'Pilot', { showQid: 'Q1', season: ['Q11', '1'], director: 'Q900', writer: 'Q901' }),
      Q102: episode('Q102', 'Second', { showQid: 'Q1', season: ['Q11', '2'], follows: 'Q101' }),
      Q201: episode('Q201', 'Third', { showQid: 'Q1', season: ['Q12', '1'], follows: 'Q102' }),
    },
  };
}

/** Imports the world's shows with a normal run, as the parts mode expects them. */
async function importShows(t: T, world: World) {
  const { client } = wikidataFor(world);
  const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, SHOWS);
  expect(result.status).toBe('finished');
}

async function runParts(t: T, world: World, deps: Partial<Parameters<typeof runWikidataImport>[0]> = {}, opts = {}) {
  const fake = wikidataFor(world);
  const result = await runWikidataImport(
    { db: t.db, client: fake.client, measureBytes: bytes(), today: TODAY, ...deps },
    { ...PARTS, ...opts },
  );
  return { ...result, fake };
}

async function workByTitle(t: T, title: string) {
  const rows = await t.db
    .select({ id: works.entityId, subtype: works.subtype, title: works.title })
    .from(works)
    .where(eq(works.title, title));
  return rows;
}

async function idOf(t: T, title: string) {
  const [row] = await workByTitle(t, title);
  if (!row) throw new Error(`no work titled ${title}`);
  return row.id;
}

/** The live parent link of `childId`, as [parentId, position]. */
async function parentOf(t: T, childId: string) {
  const [row] = await t.db
    .select({ from: relations.fromId, position: relations.position })
    .from(relations)
    .where(and(eq(relations.type, 'work_part'), eq(relations.toId, childId), isNull(relations.removedByChange)));
  return row ? [row.from, row.position] : null;
}

async function externalIdsOf(t: T, entityId: string) {
  const rows = await t.db
    .select({ scheme: relations.scheme, value: relations.value })
    .from(relations)
    .where(and(eq(relations.fromId, entityId), eq(relations.type, 'external_id'), isNull(relations.removedByChange)));
  return rows.map((r) => `${r.scheme}:${r.value}`).toSorted();
}

const countOf = async (t: T, table: typeof works | typeof creators) =>
  (await t.db.select({ n: count() }).from(table))[0]!.n;

/** The changes of each of the run's submissions, oldest first, as their ops. */
async function submissionOps(t: T, runId: string) {
  const rows = await t.db
    .select({
      submission: submissions.id,
      createdAt: submissions.createdAt,
      op: changesTable.op,
      seq: changesTable.seq,
    })
    .from(submissions)
    .innerJoin(changesTable, eq(changesTable.submissionId, submissions.id))
    .where(eq(submissions.importRunId, runId));
  const bySubmission = new Map<string, { createdAt: Date; ops: string[] }>();
  for (const r of rows.toSorted((a, b) => a.seq - b.seq)) {
    const entry = bySubmission.get(r.submission) ?? { createdAt: r.createdAt, ops: [] };
    entry.ops.push(r.op);
    bySubmission.set(r.submission, entry);
  }
  return [...bySubmission.values()].toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Takes an entity down the way an admin's legal or abuse removal does: by redacting its create. */
async function removeEntity(t: T, entityId: string) {
  const [create] = await t.db
    .select({ id: changesTable.id })
    .from(changesTable)
    .where(and(eq(changesTable.entityId, entityId), eq(changesTable.op, 'create')));
  const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin' }) });
  const res = await admin.post(`/api/admin/changes/${create!.id}/redact`, { reason: 'Abuse', removeEntity: true });
  expect(res.status, await res.clone().text()).toBe(200);
}

it("imports a show's seasons and episodes, each under its parent at Wikidata's number, one submission per season", async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({
      candidates: 1,
      shows: 1,
      partsFound: 5,
      partsAdded: 5,
      partsPresent: 0,
      partsUnplaced: 0,
      stoppedAt: 1,
      imported: 0,
      bytesPerWork: 0,
    });

    const showId = await idOf(t, 'The Show');
    const s1 = await idOf(t, 'Season 1');
    const s2 = await idOf(t, 'Season 2');
    expect(await parentOf(t, s1)).toEqual([showId, 1]);
    expect(await parentOf(t, s2)).toEqual([showId, 2]);
    expect(await parentOf(t, await idOf(t, 'Pilot'))).toEqual([s1, 1]);
    expect(await parentOf(t, await idOf(t, 'Second'))).toEqual([s1, 2]);
    expect(await parentOf(t, await idOf(t, 'Third'))).toEqual([s2, 1]);
    expect((await workByTitle(t, 'Pilot'))[0]).toMatchObject({ subtype: 'episode' });
    expect((await workByTitle(t, 'Season 1'))[0]).toMatchObject({ subtype: 'season' });
    expect(await externalIdsOf(t, s1)).toEqual(['wikidata:Q11']);

    const subs = await submissionOps(t, result.runId);
    expect(subs.map((s) => s.ops.filter((op) => op === 'create').length)).toEqual([3, 2]);
  } finally {
    await t.close();
  }
});

it('P155 adds no sequel links between episodes', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    await runParts(t, world);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'work_link'))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('P179 adds no series membership and creates no series', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    await runParts(t, world);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'series_work'))).toEqual([]);
    expect(await t.db.select().from(series)).toEqual([]);
  } finally {
    await t.close();
  }
});

it('credits only creators AMDB holds: the director is credited, the writer is counted and skipped', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ creditsSkipped: 1 });
    const pilot = await idOf(t, 'Pilot');
    const credits = await t.db
      .select({ to: relations.toId, role: relations.role })
      .from(relations)
      .where(and(eq(relations.type, 'work_creator'), eq(relations.fromId, pilot)));
    const [director] = await t.db
      .select({ id: creators.entityId })
      .from(creators)
      .where(eq(creators.name, 'Dana Director'));
    expect(credits).toEqual([{ to: director!.id, role: 'director' }]);
    expect(await t.db.select().from(creators).where(eq(creators.name, 'Wendy Writer'))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('an episode-only creator is never created', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    const before = await countOf(t, creators);
    await runParts(t, world);
    expect(await countOf(t, creators)).toBe(before);
  } finally {
    await t.close();
  }
});

it('a low max-db-bytes stops between seasons: no episode lands without its season and show', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    // Over the cap once the first season's submission has gone in.
    const measureBytes = async () => ((await workByTitle(t, 'Season 1')).length > 0 ? 5000 : 1000);
    const lines: string[] = [];
    const result = await runParts(t, world, { measureBytes, log: (l) => lines.push(l) }, { maxDbBytes: 4000 });
    expect(result.status).toBe('capped');
    expect(result.stats).toMatchObject({ partsAdded: 3, bytesStart: 1000, bytesEnd: 5000, bytesPerPart: 1333 });
    expect(lines).toContain('capped at 5000 bytes before Q12');
    const s1 = await idOf(t, 'Season 1');
    expect(await parentOf(t, await idOf(t, 'Pilot'))).toEqual([s1, 1]);
    expect(await parentOf(t, await idOf(t, 'Second'))).toEqual([s1, 2]);
    expect(await workByTitle(t, 'Season 2')).toEqual([]);
    expect(await workByTitle(t, 'Third')).toEqual([]);
    const episodes = await t.db.select({ id: works.entityId }).from(works).where(eq(works.subtype, 'episode'));
    for (const e of episodes) expect(await parentOf(t, e.id)).not.toBeNull();
  } finally {
    await t.close();
  }
});

it('an item AMDB holds as a root series, which Wikidata calls a season, is skipped and keeps its subtype', async () => {
  const t = await setupTest();
  try {
    const world: World = {
      shows: ['Q1', 'Q2'],
      seasons: [{ qid: 'Q2', show: 'Q1' }],
      episodes: [],
      entities: { Q1: show('Q1', 'The Show'), Q2: season('Q2', 'Spin-off', 'Q1', '1') },
    };
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ candidates: 2, shows: 1, partsHeldAsRoot: 1, partsAdded: 0 });
    expect(await workByTitle(t, 'Spin-off')).toEqual([expect.objectContaining({ subtype: 'series' })]);
    expect(await parentOf(t, await idOf(t, 'Spin-off'))).toBeNull();
  } finally {
    await t.close();
  }
});

it("a re-run adds only what's new and moves nothing", async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    await runParts(t, world);
    world.episodes.push({ qid: 'Q103', show: 'Q1' });
    world.entities.Q103 = episode('Q103', 'Fourth', { showQid: 'Q1', season: ['Q11', '3'] });
    const second = await runParts(t, world);
    expect(second.stats).toMatchObject({ partsAdded: 1, partsPresent: 5, partsUnplaced: 0 });
    expect(await parentOf(t, await idOf(t, 'Fourth'))).toEqual([await idOf(t, 'Season 1'), 3]);
    const third = await runParts(t, world);
    expect(third.stats).toMatchObject({ partsAdded: 0, partsPresent: 6 });
    expect(await submissionOps(t, third.runId)).toEqual([]);
    expect(await countOf(t, works)).toBe(7);
  } finally {
    await t.close();
  }
});

it('an episode a moderator reverted (its links, then its create) stays reverted', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    await runParts(t, world);
    const second = await idOf(t, 'Second');
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    // Its parent link and external ids first: a create can't be reverted while its relations stand.
    const links = await t.db
      .select({ change: relations.createdByChange })
      .from(relations)
      .where(and(eq(relations.toId, second), isNull(relations.removedByChange)));
    const ids = await t.db
      .select({ change: relations.createdByChange })
      .from(relations)
      .where(and(eq(relations.fromId, second), isNull(relations.removedByChange)));
    const [create] = await t.db
      .select({ id: changesTable.id })
      .from(changesTable)
      .where(and(eq(changesTable.entityId, second), eq(changesTable.op, 'create')));
    for (const id of [...links.map((l) => l.change), ...ids.map((l) => l.change), create!.id]) {
      const res = await mod.post(`/api/changes/${id}/revert`);
      expect(res.status, await res.clone().text()).toBe(200);
    }

    const rerun = await runParts(t, world);
    expect(rerun.stats).toMatchObject({
      partsAdded: 0,
      partsPresent: 4,
      partsSkipped: expect.objectContaining({ reverted: 1 }),
    });
    expect(await workByTitle(t, 'Second')).toHaveLength(1);
  } finally {
    await t.close();
  }
});

it('a hand-entered season under the show is adopted: it gets the wikidata id, keeps its title, and takes the episodes', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    const showId = await idOf(t, 'The Show');
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    await publish(author, mod, [
      {
        op: 'create',
        kind: 'work',
        ref: 's',
        fields: { mediaType: 'film_tv', subtype: 'season', title: 'Season One' },
      },
      { op: 'relate', type: 'work_part', from: { id: showId }, to: { ref: 's' }, data: { position: 1 } },
    ]);
    const lines: string[] = [];
    const result = await runParts(t, world, { log: (l) => lines.push(l) });
    expect(result.stats).toMatchObject({ partsAdopted: 1, partsAdded: 4 });
    const adopted = await idOf(t, 'Season One');
    expect(await workByTitle(t, 'Season 1')).toEqual([]);
    expect(await externalIdsOf(t, adopted)).toEqual(['wikidata:Q11']);
    expect(await parentOf(t, adopted)).toEqual([showId, 1]);
    expect(await parentOf(t, await idOf(t, 'Pilot'))).toEqual([adopted, 1]);
    expect(await parentOf(t, await idOf(t, 'Second'))).toEqual([adopted, 2]);
    expect(lines.some((l) => l.includes(adopted) && l.includes('Q11'))).toBe(true);
  } finally {
    await t.close();
  }
});

it('counts each part under its class, a subclass under its own QID', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    world.episodes[2] = { qid: 'Q201', show: 'Q1', cls: 'Q100269041' };
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({
      partsAdded: 5,
      partsByClass: { [SEASON_CLASS]: 2, [EPISODE_CLASS]: 2, Q100269041: 1 },
    });
  } finally {
    await t.close();
  }
});

it('an item both queries return is a season', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    world.episodes.push({ qid: 'Q12', show: 'Q1' });
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ partsFound: 5, partsAdded: 5 });
    expect(await workByTitle(t, 'Season 2')).toEqual([expect.objectContaining({ subtype: 'season' })]);
  } finally {
    await t.close();
  }
});

it('a failing batch query is asked again one show at a time', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    world.shows.push('Q2');
    world.entities.Q2 = show('Q2', 'Other Show');
    world.seasons.push({ qid: 'Q21', show: 'Q2' });
    world.entities.Q21 = season('Q21', 'Other Season', 'Q2', '1');
    await importShows(t, world);
    const fake = wikidataFor(world, { failMulti: true });
    const result = await runWikidataImport(
      { db: t.db, client: fake.client, measureBytes: bytes(), today: TODAY },
      PARTS,
    );
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({ shows: 2, partsAdded: 6 });
    expect(await parentOf(t, await idOf(t, 'Other Season'))).toEqual([await idOf(t, 'Other Show'), 1]);
  } finally {
    await t.close();
  }
});

it("a seasonless show's episodes go under the show, 25 to a submission", async () => {
  const t = await setupTest();
  try {
    const numbers = Array.from({ length: 30 }, (_, i) => i + 1);
    const world: World = {
      shows: ['Q1'],
      seasons: [],
      episodes: numbers.map((n) => ({ qid: `Q${1000 + n}`, show: 'Q1' })),
      entities: {
        Q1: show('Q1', 'The Show'),
        ...Object.fromEntries(
          numbers.map((n) => [
            `Q${1000 + n}`,
            episode(`Q${1000 + n}`, `Episode ${n}`, { showQid: 'Q1', overall: String(n) }),
          ]),
        ),
      },
    };
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ partsAdded: 30, partsUnplaced: 0 });
    const subs = await submissionOps(t, result.runId);
    expect(subs.map((s) => s.ops.filter((op) => op === 'create').length)).toEqual([25, 5]);
    const showId = await idOf(t, 'The Show');
    expect(await parentOf(t, await idOf(t, 'Episode 30'))).toEqual([showId, 30]);
  } finally {
    await t.close();
  }
});

it("an episode whose P4908 season is another show's is counted unplaced, not created", async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    world.episodes.push({ qid: 'Q301', show: 'Q1' });
    world.entities.Q301 = episode('Q301', 'Crossover', { showQid: 'Q1', season: ['Q99', '1'] });
    await importShows(t, world);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ partsAdded: 5, partsUnplaced: 1 });
    expect(await workByTitle(t, 'Crossover')).toEqual([]);
  } finally {
    await t.close();
  }
});

it('an item AMDB holds as another kind is skipped as held_as_other', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    await t.importSubmission([
      { op: 'create', kind: 'creator', ref: 'c', fields: { kind: 'person', name: 'Not An Episode' } },
      { op: 'relate', type: 'external_id', from: { ref: 'c' }, data: { scheme: 'wikidata', value: 'Q101' } },
    ]);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ partsAdded: 4, partsSkipped: expect.objectContaining({ held_as_other: 1 }) });
    expect(await workByTitle(t, 'Pilot')).toEqual([]);
  } finally {
    await t.close();
  }
});

it("a duplicate external id is retried with wikidata ids only, and the season's parts go in", async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    world.entities.Q102 = episode('Q102', 'Second', { showQid: 'Q1', season: ['Q11', '2'], imdb: 'tt0000002' });
    await importShows(t, world);
    await t.importSubmission([
      { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Holder' } },
      { op: 'relate', type: 'external_id', from: { ref: 'w' }, data: { scheme: 'imdb', value: 'tt0000002' } },
    ]);
    const result = await runParts(t, world);
    expect(result.stats).toMatchObject({ partsAdded: 5, partsSkipped: expect.objectContaining({ invalid: 0 }) });
    expect(await externalIdsOf(t, await idOf(t, 'Second'))).toEqual(['wikidata:Q102']);
  } finally {
    await t.close();
  }
});

it('an item error skips that one season: its parts are counted invalid and logged', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    await importShows(t, world);
    const showId = await idOf(t, 'The Show');
    let removed = false;
    // Once season 1 is in, an admin takes the show down before season 2's submission.
    const measureBytes = async () => {
      if (!removed && (await workByTitle(t, 'Season 1')).length > 0) {
        removed = true;
        await removeEntity(t, showId);
      }
      return 1000;
    };
    const lines: string[] = [];
    const result = await runParts(t, world, { measureBytes, log: (l) => lines.push(l) });
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({ partsAdded: 3, partsSkipped: expect.objectContaining({ invalid: 2 }) });
    expect(lines.some((l) => l.startsWith('skipped parts of Q12: '))).toBe(true);
    expect(await workByTitle(t, 'Season 2')).toEqual([]);
  } finally {
    await t.close();
  }
});

it('limit takes shows by QID number', async () => {
  const t = await setupTest();
  try {
    const world: World = {
      shows: ['Q10', 'Q9', 'Q100'],
      seasons: [
        { qid: 'Q1010', show: 'Q10' },
        { qid: 'Q1009', show: 'Q9' },
        { qid: 'Q1100', show: 'Q100' },
      ],
      episodes: [],
      entities: {
        Q9: show('Q9', 'Nine'),
        Q10: show('Q10', 'Ten'),
        Q100: show('Q100', 'Hundred'),
        Q1009: season('Q1009', 'Nine S1', 'Q9', '1'),
        Q1010: season('Q1010', 'Ten S1', 'Q10', '1'),
        Q1100: season('Q1100', 'Hundred S1', 'Q100', '1'),
      },
    };
    await importShows(t, world);
    const result = await runParts(t, world, {}, { limit: 2 });
    expect(result.stats).toMatchObject({ candidates: 2, shows: 2, partsAdded: 2 });
    const fetched = result.fake.entityCalls.flat();
    expect(fetched).toEqual(expect.arrayContaining(['Q1009', 'Q1010']));
    expect(fetched).not.toContain('Q1100');
    expect(result.fake.sparqlCalls.some((q) => askedShows(q).includes('Q100'))).toBe(false);
    expect(await workByTitle(t, 'Hundred S1')).toEqual([]);
  } finally {
    await t.close();
  }
});

it('the parts preview counts what a run would add and writes nothing', async () => {
  const t = await setupTest();
  try {
    const world = baseWorld();
    world.episodes.push({ qid: 'Q301', show: 'Q1' });
    world.entities.Q301 = episode('Q301', 'Crossover', { showQid: 'Q1', season: ['Q99', '1'] });
    await importShows(t, world);
    const runsBefore = (await t.db.select({ n: count() }).from(importRuns))[0]!.n;
    const worksBefore = await countOf(t, works);
    const { client } = wikidataFor(world);
    const preview = await previewParts({ db: t.db, client, today: TODAY }, { limit: 100 });
    expect(preview).toEqual({
      shows: 1,
      partsFound: 6,
      partsByClass: { [SEASON_CLASS]: 2, [EPISODE_CLASS]: 4 },
      placed: 5,
      partsUnplaced: 1,
      partsHeldAsRoot: 0,
      creditsSkipped: 1,
    });
    expect((await t.db.select({ n: count() }).from(importRuns))[0]!.n).toBe(runsBefore);
    expect(await countOf(t, works)).toBe(worksBefore);
  } finally {
    await t.close();
  }
});
