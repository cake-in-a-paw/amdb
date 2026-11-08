import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createWikidataClient, type WikidataEntity } from '../src/features/imports/wikidata/client.js';
import { createImportsService } from '../src/features/imports/service';
import { runWikidataImport } from '../src/features/imports/wikidata/run.js';
import {
  changes as changesTable,
  creators,
  importRuns,
  properties,
  relations,
  series,
  submissions,
  tags,
  works,
} from '../src/platform/db/schema';
import { publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const FILM_CLASS = 'Q11424';
const TODAY = new Date('2026-11-05T12:00:00Z');
const OPTS = { classes: [FILM_CLASS], minSitelinks: 10, limit: 100, maxDbBytes: Number.MAX_SAFE_INTEGER };

// --- Wikidata fixtures, in the wbgetentities shape ---

const item = (id: string) => ({ 'entity-type': 'item', id });
const claim = (property: string, value: unknown, ordinal?: string) => ({
  rank: 'normal',
  mainsnak: { snaktype: 'value', property, datavalue: { value } },
  ...(ordinal
    ? { qualifiers: { P1545: [{ snaktype: 'value', property: 'P1545', datavalue: { value: ordinal } }] } }
    : {}),
});

interface FilmSpec {
  director?: string;
  directors?: string[];
  imdb?: string;
  tmdbMovie?: string;
  follows?: string;
  genres?: string[];
  series?: { qid: string; ordinal: string };
  franchise?: string;
}
function film(id: string, title: string, spec: FilmSpec = {}): WikidataEntity {
  const claims: Record<string, unknown[]> = {
    P577: [claim('P577', { time: '+2001-05-04T00:00:00Z', precision: 11 })],
  };
  if (spec.director) claims.P57 = [claim('P57', item(spec.director))];
  if (spec.directors) claims.P57 = spec.directors.map((d) => claim('P57', item(d)));
  if (spec.imdb) claims.P345 = [claim('P345', spec.imdb)];
  if (spec.tmdbMovie) claims.P4947 = [claim('P4947', spec.tmdbMovie)];
  if (spec.follows) claims.P155 = [claim('P155', item(spec.follows))];
  if (spec.genres) claims.P136 = spec.genres.map((g) => claim('P136', item(g)));
  if (spec.series) claims.P179 = [claim('P179', item(spec.series.qid), spec.series.ordinal)];
  if (spec.franchise) claims.P8345 = [claim('P8345', item(spec.franchise))];
  // Built to the WikidataEntity shape; claims are loosely typed here to keep the fixtures short.
  return { id, labels: { en: { value: title } }, claims } as WikidataEntity;
}
const person = (id: string, name: string): WikidataEntity =>
  // Same shape note as `film`.
  ({ id, labels: { en: { value: name } }, claims: { P31: [claim('P31', item('Q5'))] } }) as WikidataEntity;
const thing = (id: string, label: string): WikidataEntity => ({ id, labels: { en: { value: label } } });

/**
 * A real client over a fake `fetch`: SPARQL answers with `candidates`, wbgetentities with
 * `entities` (absent ids come back `missing`). `down(ids)` makes an entity call answer 503.
 */
function fakeWikidata(
  candidates: { qid: string; sitelinks: number }[],
  entities: Record<string, WikidataEntity>,
  down: (ids: string[]) => boolean = () => false,
) {
  const entityCalls: string[][] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'query.wikidata.org') {
      const query = url.searchParams.get('query') ?? '';
      const bindings = query.includes(`wd:${FILM_CLASS}`)
        ? candidates.map((c) => ({
            item: { value: `http://www.wikidata.org/entity/${c.qid}` },
            sl: { value: String(c.sitelinks) },
          }))
        : [];
      return Response.json({ results: { bindings } });
    }
    const ids = (url.searchParams.get('ids') ?? '').split('|');
    entityCalls.push(ids);
    if (down(ids)) return new Response('', { status: 503 });
    return Response.json({ entities: Object.fromEntries(ids.map((id) => [id, entities[id] ?? { id, missing: '' }])) });
  };
  // The fake implements only the call shape the client uses.
  const client = createWikidataClient({ fetch: fetch as typeof globalThis.fetch, sleep: async () => {} });
  return { client, entityCalls };
}

const ranked = (...qids: string[]) => qids.map((qid, i) => ({ qid, sitelinks: 100 - i }));
const bytes = () => async () => 1000;

async function workIdByTitle(db: Awaited<ReturnType<typeof setupTest>>['db'], title: string) {
  const [row] = await db.select({ id: works.entityId }).from(works).where(eq(works.title, title));
  return row?.id;
}

async function externalIdsOf(db: Awaited<ReturnType<typeof setupTest>>['db'], entityId: string) {
  const rows = await db
    .select({ scheme: relations.scheme, value: relations.value })
    .from(relations)
    .where(and(eq(relations.fromId, entityId), eq(relations.type, 'external_id'), isNull(relations.removedByChange)));
  return rows.map((r) => `${r.scheme}:${r.value}`).toSorted();
}

const threeFilms = {
  Q1: film('Q1', 'Alpha', { director: 'Q200' }),
  Q2: film('Q2', 'Beta', { director: 'Q200' }),
  Q3: film('Q3', 'Gamma', { director: 'Q200' }),
  Q200: person('Q200', 'Dana Director'),
};

it('imports three films that share a director: one creator, three work_creator links, and wikidata ids on all four', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), threeFilms);
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({ candidates: 3, imported: 3, stoppedAt: 3 });

    const people = await t.db.select().from(creators);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ name: 'Dana Director', kind: 'person' });
    const creatorId = people[0]!.entityId;
    const links = await t.db
      .select()
      .from(relations)
      .where(and(eq(relations.type, 'work_creator'), eq(relations.toId, creatorId)));
    expect(links).toHaveLength(3);
    expect(links.every((l) => l.role === 'director')).toBe(true);

    expect(await externalIdsOf(t.db, creatorId)).toEqual(['wikidata:Q200']);
    for (const [title, qid] of [
      ['Alpha', 'Q1'],
      ['Beta', 'Q2'],
      ['Gamma', 'Q3'],
    ] as const) {
      expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, title))!)).toEqual([`wikidata:${qid}`]);
    }

    // The run is public evidence, with its stats.
    const run = (await (await t.as({ kind: 'none' }).get(`/api/import-runs/${result.runId}`)).json()) as {
      status: string;
      stats: unknown;
      licenseCheckedOn: string;
    };
    expect(run.status).toBe('finished');
    expect(run.stats).toEqual(result.stats);
    // The day the license page was last checked, recorded with the run as evidence.
    expect(run.licenseCheckedOn).toBe('2026-11-05');
  } finally {
    await t.close();
  }
});

it('a second run imports nothing new and creates no duplicate creators', async () => {
  const t = await setupTest();
  try {
    const { client, entityCalls } = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), threeFilms);
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    const callsAfterFirst = entityCalls.length;

    const second = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(second.status).toBe('finished');
    expect(second.stats.skipped.present).toBe(3);
    expect(second.stats.imported).toBe(0);
    expect(second.stats.bytesPerWork).toBe(0);
    // Present works aren't even fetched.
    expect(entityCalls.slice(callsAfterFirst)).toEqual([]);
    expect((await t.db.select({ n: count() }).from(creators))[0]!.n).toBe(1);
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(3);
  } finally {
    await t.close();
  }
});

it('a sequel_of link to a work later in the same run is added in the final pass', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Part Two', { follows: 'Q2' }),
      Q2: film('Q2', 'Part One'),
    });
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY },
      { ...OPTS, batchSize: 1 },
    );
    expect(result.stats).toMatchObject({ imported: 2, linksAdded: 1 });
    const two = await workIdByTitle(t.db, 'Part Two');
    const one = await workIdByTitle(t.db, 'Part One');
    const links = await t.db.select().from(relations).where(eq(relations.type, 'work_link'));
    expect(links).toEqual([expect.objectContaining({ fromId: two, toId: one, linkType: 'sequel_of' })]);
  } finally {
    await t.close();
  }
});

it('a link to a work already in AMDB goes in with the work, not the final pass; a self-link is skipped', async () => {
  const t = await setupTest();
  try {
    const first = fakeWikidata(ranked('Q2'), { Q2: film('Q2', 'Part One') });
    await runWikidataImport({ db: t.db, client: first.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const second = fakeWikidata(ranked('Q1', 'Q3'), {
      Q1: film('Q1', 'Part Two', { follows: 'Q2' }),
      Q3: film('Q3', 'Ouroboros', { follows: 'Q3' }),
    });
    const result = await runWikidataImport(
      { db: t.db, client: second.client, measureBytes: bytes(), today: TODAY },
      OPTS,
    );
    expect(result.stats).toMatchObject({ imported: 2, linksAdded: 0 });
    const links = await t.db.select().from(relations).where(eq(relations.type, 'work_link'));
    expect(links).toEqual([
      expect.objectContaining({
        fromId: await workIdByTitle(t.db, 'Part Two'),
        toId: await workIdByTitle(t.db, 'Part One'),
      }),
    ]);
  } finally {
    await t.close();
  }
});

it('the size cap stops before the next batch and the run is capped', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2', 'Q3', 'Q4'), {
      Q1: film('Q1', 'One'),
      Q2: film('Q2', 'Two'),
      Q3: film('Q3', 'Three'),
      Q4: film('Q4', 'Four'),
    });
    // Over the cap once batch 1's works exist, whenever it is asked.
    const measureBytes = async () => {
      const [row] = await t.db.select({ n: count() }).from(works);
      return row!.n >= 2 ? 5000 : 1000;
    };
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes, today: TODAY },
      { ...OPTS, batchSize: 2, maxDbBytes: 4000 },
    );
    expect(result.status).toBe('capped');
    expect(result.stats).toMatchObject({
      candidates: 4,
      imported: 2,
      stoppedAt: 2,
      bytesStart: 1000,
      bytesEnd: 5000,
      bytesPerWork: 2000,
    });
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(2);
    const run = (await (await t.as({ kind: 'none' }).get(`/api/import-runs/${result.runId}`)).json()) as {
      status: string;
    };
    expect(run.status).toBe('capped');
  } finally {
    await t.close();
  }
});

it('two items sharing an IMDb id: the second is imported with only its wikidata id', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Original Cut', { imdb: 'tt0000001' }),
      Q2: film('Q2', 'Director’s Cut', { imdb: 'tt0000001' }),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 2, skipped: expect.objectContaining({ duplicate_external_id: 0 }) });
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'Original Cut'))!)).toEqual([
      'imdb:tt0000001',
      'wikidata:Q1',
    ]);
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'Director’s Cut'))!)).toEqual(['wikidata:Q2']);
  } finally {
    await t.close();
  }
});

it("Wikidata down mid-run: the run is failed with the reason, and the first batch's works remain", async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(
      ranked('Q1', 'Q2', 'Q3', 'Q4'),
      { Q1: film('Q1', 'One'), Q2: film('Q2', 'Two'), Q3: film('Q3', 'Three'), Q4: film('Q4', 'Four') },
      (ids) => ids.includes('Q3'),
    );
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY },
      { ...OPTS, batchSize: 2 },
    );
    expect(result.status).toBe('failed');
    expect(result.stats).toMatchObject({ imported: 2, stoppedAt: 2 });
    expect((await t.db.select({ title: works.title }).from(works)).map((w) => w.title).toSorted()).toEqual([
      'One',
      'Two',
    ]);
    const run = (await (await t.as({ kind: 'none' }).get(`/api/import-runs/${result.runId}`)).json()) as {
      status: string;
      error: string | null;
      finishedAt: string | null;
    };
    expect(run.status).toBe('failed');
    expect(run.error).toBe('Wikidata unavailable after 5 tries');
    expect(run.finishedAt).not.toBeNull();
  } finally {
    await t.close();
  }
});

it('limit takes the most-linked candidates first', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(
      [
        { qid: 'Q1', sitelinks: 20 },
        { qid: 'Q2', sitelinks: 90 },
        { qid: 'Q3', sitelinks: 50 },
        { qid: 'Q4', sitelinks: 70 },
      ],
      { Q1: film('Q1', 'One'), Q2: film('Q2', 'Two'), Q3: film('Q3', 'Three'), Q4: film('Q4', 'Four') },
    );
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY },
      { ...OPTS, limit: 2 },
    );
    expect(result.stats).toMatchObject({ candidates: 2, imported: 2, stoppedAt: 2 });
    expect((await t.db.select({ title: works.title }).from(works)).map((w) => w.title).toSorted()).toEqual([
      'Four',
      'Two',
    ]);
  } finally {
    await t.close();
  }
});

/** Takes an entity down the way an admin's legal or abuse removal does: by redacting its create. */
async function removeEntity(t: Awaited<ReturnType<typeof setupTest>>, createChangeId: string) {
  const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin' }) });
  const res = await admin.post(`/api/admin/changes/${createChangeId}/redact`, { reason: 'Abuse', removeEntity: true });
  expect(res.status, await res.clone().text()).toBe(200);
}

it('a work that fails planning is counted invalid and logged, and the next work still goes in', async () => {
  const t = await setupTest();
  try {
    // Crafted: Wikidata caps labels at 250 characters, but genreTag doesn't, so a 600-character
    // genre label maps fine and then fails the tag's field rules (invalid_fields).
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Broken', { genres: ['Q300'] }),
      Q2: film('Q2', 'Fine'),
      Q300: thing('Q300', 'x'.repeat(600)),
    });
    const lines: string[] = [];
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY, log: (l) => lines.push(l) },
      OPTS,
    );
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ invalid: 1 }) });
    expect(lines.some((l) => l.includes('Q1') && l.includes('invalid_fields'))).toBe(true);
    expect(await workIdByTitle(t.db, 'Broken')).toBeUndefined();
    expect(await workIdByTitle(t.db, 'Fine')).toBeDefined();
  } finally {
    await t.close();
  }
});

it('a reference to a removed creator is dropped, not recreated, and the work still goes in', async () => {
  const t = await setupTest();
  try {
    // A legal or abuse removal keeps the creator's wikidata id, and the removal must stick.
    const { changes } = await t.importSubmission([
      { op: 'create', kind: 'creator', ref: 'c', fields: { kind: 'person', name: 'Taken Down' } },
      { op: 'relate', type: 'external_id', from: { ref: 'c' }, data: { scheme: 'wikidata', value: 'Q500' } },
    ]);
    await removeEntity(t, changes[0]!.id);
    const { client } = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Survivor', { director: 'Q500' }),
      Q500: person('Q500', 'Taken Down'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ invalid: 0 }) });
    expect(await workIdByTitle(t.db, 'Survivor')).toBeDefined();
    expect(await t.db.select().from(relations).where(eq(relations.type, 'work_creator'))).toEqual([]);
    expect((await t.db.select({ n: count() }).from(creators))[0]!.n).toBe(1);
  } finally {
    await t.close();
  }
});

it('a link to a removed work is dropped, and a removed work is never re-imported', async () => {
  const t = await setupTest();
  try {
    const first = fakeWikidata(ranked('Q2'), { Q2: film('Q2', 'Part One') });
    await runWikidataImport({ db: t.db, client: first.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const [create] = await t.db
      .select({ id: changesTable.id })
      .from(changesTable)
      .where(and(eq(changesTable.entityId, (await workIdByTitle(t.db, 'Part One'))!), eq(changesTable.op, 'create')));
    await removeEntity(t, create!.id);

    const second = fakeWikidata(ranked('Q2', 'Q1'), {
      Q1: film('Q1', 'Part Two', { follows: 'Q2' }),
      Q2: film('Q2', 'Part One'),
    });
    const result = await runWikidataImport(
      { db: t.db, client: second.client, measureBytes: bytes(), today: TODAY },
      OPTS,
    );
    expect(result.stats).toMatchObject({
      imported: 1,
      linksAdded: 0,
      linksFailed: 0,
      skipped: expect.objectContaining({ present: 1, invalid: 0 }),
    });
    expect(await workIdByTitle(t.db, 'Part Two')).toBeDefined();
    expect(await t.db.select().from(relations).where(eq(relations.type, 'work_link'))).toEqual([]);
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(2);
  } finally {
    await t.close();
  }
});

it('a reference AMDB already holds as another kind is dropped, and the work still goes in', async () => {
  const t = await setupTest();
  try {
    // Q400 is already a work, so a film naming it as its series keeps everything but that link.
    const first = fakeWikidata(ranked('Q400'), { Q400: film('Q400', 'The Saga') });
    await runWikidataImport({ db: t.db, client: first.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const second = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Episode One', { series: { qid: 'Q400', ordinal: '1' }, director: 'Q200' }),
      Q200: person('Q200', 'Dana Director'),
    });
    const result = await runWikidataImport(
      { db: t.db, client: second.client, measureBytes: bytes(), today: TODAY },
      OPTS,
    );
    expect(result.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ invalid: 0 }) });
    expect(await workIdByTitle(t.db, 'Episode One')).toBeDefined();
    expect(await t.db.select().from(relations).where(eq(relations.type, 'series_work'))).toEqual([]);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'work_creator'))).toHaveLength(1);
  } finally {
    await t.close();
  }
});

it('a genre whose slug belongs to a retracted tag is dropped, not recreated', async () => {
  const t = await setupTest();
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const { changes } = await t.importSubmission([
      { op: 'create', kind: 'tag', ref: 'g', fields: { kind: 'genre', name: 'Drama', slug: 'drama' } },
    ]);
    const res = await mod.post(`/api/changes/${changes[0]!.id}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
    const { client } = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Tearjerker', { genres: ['Q300', 'Q302'] }),
      Q300: thing('Q300', 'drama film'),
      Q302: thing('Q302', 'comedy film'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ invalid: 0 }) });
    expect((await t.db.select({ slug: tags.slug }).from(tags)).map((r) => r.slug).toSorted()).toEqual([
      'comedy',
      'drama',
    ]);
    const tagLinks = await t.db.select({ toId: relations.toId }).from(relations).where(eq(relations.type, 'work_tag'));
    const [comedy] = await t.db.select({ id: tags.entityId }).from(tags).where(eq(tags.slug, 'comedy'));
    expect(tagLinks).toEqual([{ toId: comedy!.id }]);
  } finally {
    await t.close();
  }
});

it('a work, director and genre labeled only in mul (all languages) import under that label', async () => {
  const t = await setupTest();
  try {
    const mulOnly = (e: WikidataEntity): WikidataEntity => ({ ...e, labels: { mul: e.labels!.en! } });
    const { client } = fakeWikidata(ranked('Q1'), {
      Q1: mulOnly(film('Q1', 'Forrest Gump', { director: 'Q200', genres: ['Q300'] })),
      Q200: mulOnly(person('Q200', 'Robert Zemeckis')),
      Q300: mulOnly(thing('Q300', 'drama film')),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ no_title: 0 }) });
    expect(await workIdByTitle(t.db, 'Forrest Gump')).toBeDefined();
    expect((await t.db.select({ name: creators.name }).from(creators)).map((r) => r.name)).toEqual(['Robert Zemeckis']);
    expect((await t.db.select({ slug: tags.slug }).from(tags)).map((r) => r.slug)).toEqual(['drama']);
  } finally {
    await t.close();
  }
});

it('a final-pass link that can’t be added is counted in linksFailed and logged', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), {
      Q1: film('Q1', 'Part Two', { follows: 'Q2' }),
      Q2: film('Q2', 'Part One'),
      Q3: film('Q3', 'Unrelated'),
    });
    // Mid-run, once Part One is in, a moderator takes it down: the deferred link then has no live target.
    let removed = false;
    const measureBytes = async () => {
      const [row] = await t.db.select({ id: works.entityId }).from(works).where(eq(works.title, 'Part One'));
      if (row && !removed) {
        removed = true;
        const [create] = await t.db
          .select({ id: changesTable.id })
          .from(changesTable)
          .where(and(eq(changesTable.entityId, row.id), eq(changesTable.op, 'create')));
        await removeEntity(t, create!.id);
      }
      return 1000;
    };
    const lines: string[] = [];
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes, today: TODAY, log: (l) => lines.push(l) },
      { ...OPTS, batchSize: 1 },
    );
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({ imported: 3, linksAdded: 0, linksFailed: 1 });
    expect(lines.some((l) => l.includes('Q2') && l.includes('unknown_entity'))).toBe(true);
  } finally {
    await t.close();
  }
});

it('a candidate Wikidata doesn’t return is counted missing; one without an English label is no_title', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), {
      Q1: film('Q1', 'Here'),
      Q3: { id: 'Q3', labels: {} },
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({
      candidates: 3,
      imported: 1,
      stoppedAt: 3,
      skipped: { present: 0, held_as_other: 0, no_title: 1, duplicate_external_id: 0, missing: 1, invalid: 0 },
    });
  } finally {
    await t.close();
  }
});

it('series, franchises and genres become entries reused across works; genre tags reuse an existing slug', async () => {
  const t = await setupTest();
  try {
    await t.importSubmission([
      { op: 'create', kind: 'tag', ref: 'g', fields: { kind: 'genre', name: 'Comedy', slug: 'comedy' } },
    ]);
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'First', {
        genres: ['Q300', 'Q301', 'Q302'],
        series: { qid: 'Q400', ordinal: '1' },
        franchise: 'Q450',
      }),
      Q2: film('Q2', 'Second', { genres: ['Q300'], series: { qid: 'Q400', ordinal: '2' }, franchise: 'Q450' }),
      Q300: thing('Q300', 'drama film'),
      Q301: thing('Q301', 'drama'),
      Q302: thing('Q302', 'comedy film'),
      Q400: thing('Q400', 'The Saga'),
      Q450: thing('Q450', 'The Franchise'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 2, skipped: expect.objectContaining({ invalid: 0 }) });

    expect((await t.db.select({ slug: tags.slug }).from(tags)).map((r) => r.slug).toSorted()).toEqual([
      'comedy',
      'drama',
    ]);
    const tagLinks = await t.db.select().from(relations).where(eq(relations.type, 'work_tag'));
    expect(tagLinks).toHaveLength(3);
    const seriesLinks = await t.db.select().from(relations).where(eq(relations.type, 'series_work'));
    expect(seriesLinks.map((r) => r.position).toSorted()).toEqual([1, 2]);
    expect(new Set(seriesLinks.map((r) => r.fromId)).size).toBe(1);
    expect(await externalIdsOf(t.db, seriesLinks[0]!.fromId)).toEqual(['wikidata:Q400']);
    const propertyLinks = await t.db.select().from(relations).where(eq(relations.type, 'property_work'));
    expect(propertyLinks).toHaveLength(2);
    expect(new Set(propertyLinks.map((r) => r.fromId)).size).toBe(1);
  } finally {
    await t.close();
  }
});

it('measures the real database size when no measure is injected', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'One') });
    const result = await runWikidataImport({ db: t.db, client, today: TODAY }, OPTS);
    expect(result.stats.bytesStart).toBeGreaterThan(0);
    expect(result.stats.bytesEnd).toBeGreaterThanOrEqual(result.stats.bytesStart);
    expect(Number.isFinite(result.stats.bytesPerWork)).toBe(true);
  } finally {
    await t.close();
  }
});

it('fetches references in chunks of at most 50 ids', async () => {
  const t = await setupTest();
  try {
    const directors = Array.from({ length: 60 }, (_, i) => `Q${1000 + i}`);
    const { client, entityCalls } = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Crowded', { directors }),
      ...Object.fromEntries(directors.map((d, i) => [d, person(d, `Director ${i}`)])),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats.imported).toBe(1);
    expect(Math.max(...entityCalls.map((c) => c.length))).toBeLessThanOrEqual(50);
    expect((await t.db.select({ n: count() }).from(creators))[0]!.n).toBe(60);
  } finally {
    await t.close();
  }
});

it('any other error finishes the run failed with a generic message, logs the detail, and is rethrown', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'One') });
    let calls = 0;
    const measureBytes = async () => {
      if (++calls === 2) throw new Error('disk gone');
      return 1000;
    };
    const lines: string[] = [];
    await expect(
      runWikidataImport({ db: t.db, client, measureBytes, today: TODAY, log: (l) => lines.push(l) }, OPTS),
    ).rejects.toThrow('disk gone');
    // The run page is public; internal detail goes to the operator's log only.
    expect(lines.some((l) => l.includes('disk gone'))).toBe(true);
    const [{ id: runId }] = (await t.db.select({ id: importRuns.id }).from(importRuns)) as [{ id: string }];
    const run = (await (await t.as({ kind: 'none' }).get(`/api/import-runs/${runId}`)).json()) as {
      status: string;
      error: string | null;
      finishedAt: string | null;
    };
    expect(run).toMatchObject({ status: 'failed', error: "internal error (see the importer's log)" });
    expect(run.finishedAt).not.toBeNull();
  } finally {
    await t.close();
  }
});

it('one QID named in two roles of different kinds keeps the first and drops the other', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Auteur Piece', { director: 'Q200', franchise: 'Q200' }),
      Q200: person('Q200', 'Dana Director'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ invalid: 0 }) });
    expect(await t.db.select().from(relations).where(eq(relations.type, 'work_creator'))).toHaveLength(1);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'property_work'))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('works win: a reference to a QID that is a later candidate is dropped, and that candidate imports as a work', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q400'), {
      Q1: film('Q1', 'Spin-off', { series: { qid: 'Q400', ordinal: '1' } }),
      Q400: film('Q400', 'The Saga'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({
      imported: 2,
      skipped: expect.objectContaining({ duplicate_external_id: 0, invalid: 0 }),
    });
    expect(await workIdByTitle(t.db, 'Spin-off')).toBeDefined();
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'The Saga'))!)).toEqual(['wikidata:Q400']);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'series_work'))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('if recording the failure fails too, the original error is the one thrown', async () => {
  const t = await setupTest();
  let closed = false;
  try {
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'One') });
    let calls = 0;
    // The database goes away along with the measure, so finishRun can't write the failure either.
    const measureBytes = async () => {
      if (++calls === 2) {
        await t.close();
        closed = true;
        throw new Error('disk gone');
      }
      return 1000;
    };
    const lines: string[] = [];
    await expect(
      runWikidataImport({ db: t.db, client, measureBytes, today: TODAY, log: (l) => lines.push(l) }, OPTS),
    ).rejects.toThrow('disk gone');
    expect(lines.some((l) => l.includes('could not record'))).toBe(true);
  } finally {
    if (!closed) await t.close();
  }
});

it('a work a moderator reverted (its wikidata id, then its create) is never re-imported', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'Undone') });
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    const workId = (await workIdByTitle(t.db, 'Undone'))!;
    const rows = await t.db
      .select({ id: changesTable.id, op: changesTable.op })
      .from(changesTable)
      .where(eq(changesTable.entityId, workId));
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    // The external id first: a create can't be reverted while its relations stand.
    for (const op of ['relate', 'create'] as const) {
      const change = rows.find((r) => r.op === op);
      const res = await mod.post(`/api/changes/${change!.id}/revert`);
      expect(res.status, await res.clone().text()).toBe(200);
    }

    const second = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(second.stats).toMatchObject({ imported: 0, skipped: expect.objectContaining({ present: 1 }) });
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(1);
  } finally {
    await t.close();
  }
});

it('works win across runs: a discovered candidate beyond the limit is not created as a series, and a later run imports it as a work', async () => {
  const t = await setupTest();
  try {
    // Q1 names Q9 as its series; both are discovered, Q1 ranks first.
    const { client } = fakeWikidata(ranked('Q1', 'Q9'), {
      Q1: film('Q1', 'Episode One', { series: { qid: 'Q9', ordinal: '1' } }),
      Q9: film('Q9', 'The Saga'),
    });
    const first = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY },
      { ...OPTS, limit: 1 },
    );
    expect(first.stats).toMatchObject({ candidates: 1, imported: 1 });
    expect(await t.db.select().from(series)).toEqual([]);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'series_work'))).toEqual([]);

    const second = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY },
      { ...OPTS, limit: 2 },
    );
    expect(second.stats).toMatchObject({ imported: 1, skipped: expect.objectContaining({ present: 1 }) });
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'The Saga'))!)).toEqual(['wikidata:Q9']);
  } finally {
    await t.close();
  }
});

it('a candidate AMDB already holds as another kind is skipped as held_as_other and logged', async () => {
  const t = await setupTest();
  try {
    // Someone added Q9 as a series before Wikidata's class put it among the works.
    await t.importSubmission([
      { op: 'create', kind: 'series', ref: 's', fields: { title: 'The Saga' } },
      { op: 'relate', type: 'external_id', from: { ref: 's' }, data: { scheme: 'wikidata', value: 'Q9' } },
    ]);
    const { client } = fakeWikidata(ranked('Q9'), { Q9: film('Q9', 'The Saga') });
    const lines: string[] = [];
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes: bytes(), today: TODAY, log: (l) => lines.push(l) },
      OPTS,
    );
    expect(result.stats).toMatchObject({
      imported: 0,
      skipped: expect.objectContaining({ present: 0, held_as_other: 1 }),
    });
    expect(lines.some((l) => l.includes('Q9') && l.includes('series'))).toBe(true);
    expect(await t.db.select().from(works)).toEqual([]);
  } finally {
    await t.close();
  }
});

it('one run at a time: a second concurrent run is refused before it records a run', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), { Q1: film('Q1', 'One'), Q2: film('Q2', 'Two') });
    const deps = { db: t.db, client, measureBytes: bytes(), today: TODAY };
    const results = await Promise.allSettled([runWikidataImport(deps, OPTS), runWikidataImport(deps, OPTS)]);
    const done = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(done).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch(/another import run is already running/);
    expect((await t.db.select({ n: count() }).from(importRuns))[0]!.n).toBe(1);
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(2);
  } finally {
    await t.close();
  }
});

it('an abort stops the run between batches and finishes it failed with "interrupted"', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), {
      Q1: film('Q1', 'One'),
      Q2: film('Q2', 'Two'),
      Q3: film('Q3', 'Three'),
    });
    const controller = new AbortController();
    let calls = 0;
    // Call 1 is bytesStart, call 2 precedes batch 1; the operator presses Ctrl-C during batch 1.
    const measureBytes = async () => {
      if (++calls === 3) controller.abort();
      return 1000;
    };
    const result = await runWikidataImport(
      { db: t.db, client, measureBytes, today: TODAY, signal: controller.signal },
      { ...OPTS, batchSize: 1 },
    );
    expect(result.status).toBe('failed');
    expect(result.stats).toMatchObject({ imported: 1, stoppedAt: 1 });
    const run = (await (await t.as({ kind: 'none' }).get(`/api/import-runs/${result.runId}`)).json()) as {
      status: string;
      error: string | null;
    };
    expect(run).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(1);
  } finally {
    await t.close();
  }
});

it('a run whose row was closed under it stops with run_not_running instead of skipping every work', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), { Q1: film('Q1', 'One'), Q2: film('Q2', 'Two') });
    let calls = 0;
    // Before batch 1, something else (an operator's manual fix) marks the run failed.
    const measureBytes = async () => {
      if (++calls === 2) {
        const [run] = await t.db.select({ id: importRuns.id }).from(importRuns);
        await createImportsService(t.db).finishRun(run!.id, { status: 'failed', stats: {}, error: 'closed by hand' });
      }
      return 1000;
    };
    await expect(runWikidataImport({ db: t.db, client, measureBytes, today: TODAY }, OPTS)).rejects.toMatchObject({
      code: 'run_not_running',
    });
    expect(await t.db.select().from(works)).toEqual([]);
    // The hand-recorded outcome stands.
    const [run] = await t.db.select().from(importRuns);
    expect(run).toMatchObject({ status: 'failed', error: 'closed by hand' });
  } finally {
    await t.close();
  }
});

// --- Backfill: references a work is missing, added to works already imported ---

/** An item Wikidata returned with no label in any language read: its reference is dropped at import. */
const unlabeled = (e: WikidataEntity): WikidataEntity => ({ ...e, labels: {} });
const BACKFILL = { ...OPTS, backfill: true };

async function relationsOf(db: Awaited<ReturnType<typeof setupTest>>['db'], type: 'work_creator' | 'work_link') {
  return db.select().from(relations).where(eq(relations.type, type));
}

it('backfill: a director dropped at import time (no label then) is created and credited', async () => {
  const t = await setupTest();
  try {
    const before = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Forrest Gump', { director: 'Q200' }),
      Q200: unlabeled(person('Q200', 'Robert Zemeckis')),
    });
    await runWikidataImport({ db: t.db, client: before.client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(await relationsOf(t.db, 'work_creator')).toEqual([]);

    const after = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Forrest Gump', { director: 'Q200' }),
      Q200: person('Q200', 'Robert Zemeckis'),
    });
    const result = await runWikidataImport(
      { db: t.db, client: after.client, measureBytes: bytes(), today: TODAY },
      BACKFILL,
    );
    expect(result.status).toBe('finished');
    expect(result.stats).toMatchObject({ imported: 0, backfilled: 1, upToDate: 0, relationsAdded: 1 });

    const [director] = await t.db.select().from(creators);
    expect(director).toMatchObject({ name: 'Robert Zemeckis', kind: 'person' });
    expect(await externalIdsOf(t.db, director!.entityId)).toEqual(['wikidata:Q200']);
    const workId = (await workIdByTitle(t.db, 'Forrest Gump'))!;
    expect(await relationsOf(t.db, 'work_creator')).toEqual([
      expect.objectContaining({ fromId: workId, toId: director!.entityId, role: 'director' }),
    ]);
    // The work itself is untouched: still one create, and only its own wikidata id.
    expect((await t.db.select({ n: count() }).from(works))[0]!.n).toBe(1);
    expect(await externalIdsOf(t.db, workId)).toEqual(['wikidata:Q1']);
    const [run] = await t.db.select().from(importRuns).where(eq(importRuns.id, result.runId));
    expect(run!.params).toMatchObject({ backfill: true });
  } finally {
    await t.close();
  }
});

it('backfill: genre, series and franchise references and a work link are each added', async () => {
  const t = await setupTest();
  try {
    const spec = { genres: ['Q300'], series: { qid: 'Q400', ordinal: '2' }, franchise: 'Q450', follows: 'Q2' };
    // Run 1 imports only the sequel, whose references have no labels yet; run 2 imports its prequel.
    const first = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Part Two', spec),
      Q300: unlabeled(thing('Q300', 'drama film')),
      Q400: unlabeled(thing('Q400', 'The Saga')),
      Q450: unlabeled(thing('Q450', 'The Franchise')),
    });
    await runWikidataImport(
      { db: t.db, client: first.client, measureBytes: bytes(), today: TODAY },
      { ...OPTS, limit: 1 },
    );
    const second = fakeWikidata(ranked('Q2'), { Q2: film('Q2', 'Part One') });
    await runWikidataImport({ db: t.db, client: second.client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(await relationsOf(t.db, 'work_link')).toEqual([]);

    const now = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Part Two', spec),
      Q2: film('Q2', 'Part One'),
      Q300: thing('Q300', 'drama film'),
      Q400: thing('Q400', 'The Saga'),
      Q450: thing('Q450', 'The Franchise'),
    });
    const result = await runWikidataImport(
      { db: t.db, client: now.client, measureBytes: bytes(), today: TODAY },
      BACKFILL,
    );
    expect(result.stats).toMatchObject({ backfilled: 1, upToDate: 1, relationsAdded: 4 });

    const two = (await workIdByTitle(t.db, 'Part Two'))!;
    const one = (await workIdByTitle(t.db, 'Part One'))!;
    expect(await relationsOf(t.db, 'work_link')).toEqual([
      expect.objectContaining({ fromId: two, toId: one, linkType: 'sequel_of' }),
    ]);
    expect((await t.db.select({ slug: tags.slug }).from(tags)).map((r) => r.slug)).toEqual(['drama']);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'work_tag'))).toEqual([
      expect.objectContaining({ fromId: two }),
    ]);
    const [saga] = await t.db.select().from(series);
    expect(saga).toMatchObject({ title: 'The Saga' });
    expect(await externalIdsOf(t.db, saga!.entityId)).toEqual(['wikidata:Q400']);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'series_work'))).toEqual([
      expect.objectContaining({ fromId: saga!.entityId, toId: two, position: 2 }),
    ]);
    const [franchise] = await t.db.select().from(properties);
    expect(await externalIdsOf(t.db, franchise!.entityId)).toEqual(['wikidata:Q450']);
    expect(await t.db.select().from(relations).where(eq(relations.type, 'property_work'))).toEqual([
      expect.objectContaining({ fromId: franchise!.entityId, toId: two }),
    ]);
  } finally {
    await t.close();
  }
});

it('backfill: a credit a moderator unrelated is not re-added, and nothing is submitted for the work', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Alpha', { director: 'Q200' }),
      Q200: person('Q200', 'Dana Director'),
    });
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    const [credit] = await relationsOf(t.db, 'work_creator');
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    await publish(author, mod, [{ op: 'unrelate', relationId: credit!.id }]);

    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({ backfilled: 0, upToDate: 1, relationsAdded: 0 });
    expect(await relationsOf(t.db, 'work_creator')).toEqual([
      expect.objectContaining({ id: credit!.id, removedByChange: expect.any(String) }),
    ]);
    // No empty submission either.
    expect(await t.db.select().from(submissions).where(eq(submissions.importRunId, result.runId))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: a second backfill adds nothing and counts every work up to date', async () => {
  const t = await setupTest();
  try {
    const before = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), { ...threeFilms, Q200: unlabeled(threeFilms.Q200) });
    await runWikidataImport({ db: t.db, client: before.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const { client } = fakeWikidata(ranked('Q1', 'Q2', 'Q3'), threeFilms);
    const first = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(first.stats).toMatchObject({ backfilled: 3, upToDate: 0, relationsAdded: 3 });
    expect((await t.db.select({ n: count() }).from(creators))[0]!.n).toBe(1);

    const again = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(again.status).toBe('finished');
    expect(again.stats).toMatchObject({ backfilled: 0, upToDate: 3, relationsAdded: 0 });
    expect(await relationsOf(t.db, 'work_creator')).toHaveLength(3);
    expect(await t.db.select().from(submissions).where(eq(submissions.importRunId, again.runId))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: a work a person entered, with a wikidata id, is left alone', async () => {
  const t = await setupTest();
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    await publish(author, mod, [
      { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Alpha' } },
      { op: 'relate', type: 'external_id', from: { ref: 'w' }, data: { scheme: 'wikidata', value: 'Q1' } },
    ]);
    const { client, entityCalls } = fakeWikidata(ranked('Q1'), {
      Q1: film('Q1', 'Alpha', { director: 'Q200' }),
      Q200: person('Q200', 'Dana Director'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({
      backfilled: 0,
      upToDate: 0,
      skipped: expect.objectContaining({ present: 1 }),
    });
    expect(entityCalls).toEqual([]);
    expect(await t.db.select().from(creators)).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: a candidate that isn’t in AMDB is not imported', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'Alpha') });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({ imported: 0, skipped: expect.objectContaining({ not_present: 1 }) });
    expect(await t.db.select().from(works)).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: a merged-away work’s references are not added to its winner', async () => {
  const t = await setupTest();
  try {
    const before = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Alpha'),
      Q2: film('Q2', 'Alpha (duplicate)', { director: 'Q200' }),
      Q200: unlabeled(person('Q200', 'Dana Director')),
    });
    await runWikidataImport({ db: t.db, client: before.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const kept = (await workIdByTitle(t.db, 'Alpha'))!;
    const loser = (await workIdByTitle(t.db, 'Alpha (duplicate)'))!;
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    await publish(author, mod, [{ op: 'merge', kind: 'work', from: loser, into: kept }]);

    const after = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Alpha'),
      Q2: film('Q2', 'Alpha (duplicate)', { director: 'Q200' }),
      Q200: person('Q200', 'Dana Director'),
    });
    const result = await runWikidataImport(
      { db: t.db, client: after.client, measureBytes: bytes(), today: TODAY },
      BACKFILL,
    );
    expect(result.stats).toMatchObject({
      backfilled: 0,
      upToDate: 1,
      skipped: expect.objectContaining({ present: 1 }),
    });
    expect(await t.db.select().from(creators)).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: works win, so a reference that is itself a candidate is still dropped', async () => {
  const t = await setupTest();
  try {
    // Q400 is discovered as a work (beyond the limit, and not in AMDB) and named as Q1's series.
    const { client } = fakeWikidata(ranked('Q1', 'Q400'), {
      Q1: film('Q1', 'Spin-off', { series: { qid: 'Q400', ordinal: '1' } }),
      Q400: film('Q400', 'The Saga'),
    });
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, { ...OPTS, limit: 1 });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({
      backfilled: 0,
      upToDate: 1,
      skipped: expect.objectContaining({ not_present: 1 }),
    });
    expect(await t.db.select().from(series)).toEqual([]);
  } finally {
    await t.close();
  }
});

/** A film whose series and franchise had no labels when it was imported, then got them. */
async function importWithoutSeriesAndFranchise(t: Awaited<ReturnType<typeof setupTest>>) {
  const spec = { series: { qid: 'Q400', ordinal: '1' }, franchise: 'Q450' };
  const before = fakeWikidata(ranked('Q1'), {
    Q1: film('Q1', 'Episode One', spec),
    Q400: unlabeled(thing('Q400', 'The Saga')),
    Q450: unlabeled(thing('Q450', 'The Franchise')),
  });
  await runWikidataImport({ db: t.db, client: before.client, measureBytes: bytes(), today: TODAY }, OPTS);
  return fakeWikidata(ranked('Q1'), {
    Q1: film('Q1', 'Episode One', spec),
    Q400: thing('Q400', 'The Saga'),
    Q450: thing('Q450', 'The Franchise'),
  }).client;
}

const referenceLinks = (db: Awaited<ReturnType<typeof setupTest>>['db']) =>
  db
    .select()
    .from(relations)
    .where(and(inArray(relations.type, ['series_work', 'property_work'])));

it('backfill: a second backfill adds no series or franchise relation again', async () => {
  const t = await setupTest();
  try {
    const client = await importWithoutSeriesAndFranchise(t);
    const first = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(first.stats).toMatchObject({ backfilled: 1, relationsAdded: 2 });
    const again = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(again.stats).toMatchObject({ backfilled: 0, upToDate: 1, relationsAdded: 0 });
    expect(await referenceLinks(t.db)).toHaveLength(2);
    expect(await t.db.select().from(submissions).where(eq(submissions.importRunId, again.runId))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: a series or franchise relation a moderator removed is not re-added', async () => {
  const t = await setupTest();
  try {
    const client = await importWithoutSeriesAndFranchise(t);
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    for (const link of await referenceLinks(t.db))
      await publish(author, mod, [{ op: 'unrelate', relationId: link.id }]);

    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({ backfilled: 0, upToDate: 1, relationsAdded: 0 });
    const links = await referenceLinks(t.db);
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.removedByChange !== null)).toBe(true);
  } finally {
    await t.close();
  }
});

// --- Backfill: external ids the work's Wikidata item now carries ---

it('a work whose new tmdb id another work already holds still imports, without the clashing ids', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Original Cut', { tmdbMovie: '603' }),
      Q2: film('Q2', 'Director’s Cut', { tmdbMovie: '603', imdb: 'tt0000002' }),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    expect(result.stats).toMatchObject({ imported: 2, skipped: expect.objectContaining({ duplicate_external_id: 0 }) });
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'Original Cut'))!)).toEqual([
      'tmdb_movie:603',
      'wikidata:Q1',
    ]);
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'Director’s Cut'))!)).toEqual(['wikidata:Q2']);
  } finally {
    await t.close();
  }
});

it('backfill: a work imported before its tmdb id was on Wikidata gains tmdb_movie', async () => {
  const t = await setupTest();
  try {
    const before = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'The Matrix') });
    await runWikidataImport({ db: t.db, client: before.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'The Matrix', { tmdbMovie: '603' }) });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({ backfilled: 1, idsAdded: 1, idsSkippedHeld: 0, relationsAdded: 0 });
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'The Matrix'))!)).toEqual([
      'tmdb_movie:603',
      'wikidata:Q1',
    ]);
    const again = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(again.stats).toMatchObject({ backfilled: 0, upToDate: 1, idsAdded: 0 });
  } finally {
    await t.close();
  }
});

it('backfill: a tmdb id a moderator removed is not added back', async () => {
  const t = await setupTest();
  try {
    const { client } = fakeWikidata(ranked('Q1'), { Q1: film('Q1', 'The Matrix', { tmdbMovie: '603' }) });
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    const [tmdb] = await t.db.select().from(relations).where(eq(relations.scheme, 'tmdb_movie'));
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    await publish(author, mod, [{ op: 'unrelate', relationId: tmdb!.id }]);

    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({ backfilled: 0, upToDate: 1, idsAdded: 0, idsSkippedHeld: 0 });
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'The Matrix'))!)).toEqual(['wikidata:Q1']);
    expect(await t.db.select().from(submissions).where(eq(submissions.importRunId, result.runId))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: an id another live work holds is skipped, and nothing is submitted', async () => {
  const t = await setupTest();
  try {
    // The second import drops the shared IMDb id (the existing retry), so Q2 never held it.
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Original Cut', { imdb: 'tt0000001' }),
      Q2: film('Q2', 'Director’s Cut', { imdb: 'tt0000001' }),
    });
    await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, OPTS);
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({ backfilled: 0, upToDate: 2, idsAdded: 0, idsSkippedHeld: 1 });
    expect(await t.db.select().from(submissions).where(eq(submissions.importRunId, result.runId))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('backfill: two works with the same new id in one run: the first gets it, the second still gets its creator', async () => {
  const t = await setupTest();
  try {
    const before = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Original Cut', { director: 'Q200' }),
      Q2: film('Q2', 'Director’s Cut', { director: 'Q200' }),
      Q200: unlabeled(person('Q200', 'Dana Director')),
    });
    await runWikidataImport({ db: t.db, client: before.client, measureBytes: bytes(), today: TODAY }, OPTS);
    const { client } = fakeWikidata(ranked('Q1', 'Q2'), {
      Q1: film('Q1', 'Original Cut', { director: 'Q200', tmdbMovie: '603' }),
      Q2: film('Q2', 'Director’s Cut', { director: 'Q200', tmdbMovie: '603' }),
      Q200: person('Q200', 'Dana Director'),
    });
    const result = await runWikidataImport({ db: t.db, client, measureBytes: bytes(), today: TODAY }, BACKFILL);
    expect(result.stats).toMatchObject({
      backfilled: 2,
      idsAdded: 1,
      idsSkippedHeld: 1,
      relationsAdded: 2,
      skipped: expect.objectContaining({ invalid: 0 }),
    });
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'Original Cut'))!)).toContain('tmdb_movie:603');
    expect(await externalIdsOf(t.db, (await workIdByTitle(t.db, 'Director’s Cut'))!)).toEqual(['wikidata:Q2']);
    expect(await relationsOf(t.db, 'work_creator')).toHaveLength(2);
  } finally {
    await t.close();
  }
});
