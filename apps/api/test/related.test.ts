import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { entities } from '../src/platform/db/schema';
import { publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (title: string, ref: string, releaseYear?: number) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype: 'movie', title, ...(releaseYear ? { releaseYear } : {}) },
});
const creator = { op: 'create', kind: 'creator', ref: 'cr', fields: { name: 'Ada', kind: 'person' } };
const series = { op: 'create', kind: 'series', ref: 'se', fields: { title: 'Saga' } };
const property = { op: 'create', kind: 'property', ref: 'pr', fields: { title: 'Verse' } };
const directed = (w: string) => ({
  op: 'relate',
  type: 'work_creator',
  from: { ref: w },
  to: { ref: 'cr' },
  data: { role: 'director' },
});
const inSeries = (w: string, position: number) => ({
  op: 'relate',
  type: 'series_work',
  from: { ref: 'se' },
  to: { ref: w },
  data: { position },
});
const inProperty = (w: string) => ({
  op: 'relate',
  type: 'property_work',
  from: { ref: 'pr' },
  to: { ref: w },
  data: {},
});

type Group<K extends string> = { [P in K]: { title: string } } & { works: { id: string; title: string }[] };
type Related = { byCreator: Group<'creator'>[]; bySeries: Group<'series'>[]; byProperty: Group<'property'>[] };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  const related = async (id: string) => {
    const res = await anon.get(`/api/entities/${id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { relations: { related?: Related } }).relations.related;
  };
  return { t, author, mod, anon, related };
}

it('groups other works by shared creator, series and property, never the work itself', async () => {
  const { t, author, mod, related } = await setup();
  try {
    const made = await publish(author, mod, [
      work('A', 'a'),
      work('B', 'b'),
      work('C', 'c'),
      work('D', 'd'),
      creator,
      series,
      property,
      directed('a'),
      directed('b'),
      inSeries('a', 1),
      inSeries('c', 2),
      inProperty('a'),
      inProperty('d'),
    ]);
    const a = made.changes[0]!.entityId!;
    const rel = (await related(a))!;
    expect(rel.byCreator.map((g) => [g.creator.title, g.works.map((w) => w.title)])).toEqual([['Ada', ['B']]]);
    expect(rel.bySeries.map((g) => [g.series.title, g.works.map((w) => w.title)])).toEqual([['Saga', ['C']]]);
    expect(rel.byProperty.map((g) => [g.property.title, g.works.map((w) => w.title)])).toEqual([['Verse', ['D']]]);
    expect(JSON.stringify(rel)).not.toContain(a);
    // Only works have related; a creator's view has none.
    expect(await related(made.changes[4]!.entityId!)).toBeUndefined();
  } finally {
    await t.close();
  }
});

it('cuts a group at 12 works, ordered by release year then title', async () => {
  const { t, author, mod, related } = await setup();
  try {
    const refs = Array.from({ length: 13 }, (_, i) => `w${i}`);
    const made = await publish(author, mod, [
      work('Main', 'main', 2000),
      ...refs.map((r, i) => work(`Work ${String(i).padStart(2, '0')}`, r, 2001 + (i % 2))),
      creator,
      directed('main'),
      ...refs.map(directed),
    ]);
    const group = (await related(made.changes[0]!.entityId!))!.byCreator[0]!;
    expect(group.works).toHaveLength(12);
    // Even indexes are 2001, odd 2002: the 2001 works first (7 of them), then 2002 by title; 2002's last (w11... w12 is 2001) is cut.
    expect(group.works.map((w) => w.title)).toEqual(
      [0, 2, 4, 6, 8, 10, 12, 1, 3, 5, 7, 9].map((i) => `Work ${String(i).padStart(2, '0')}`),
    );
  } finally {
    await t.close();
  }
});

it('leaves out merged-away and removed works', async () => {
  const { t, author, mod, related } = await setup();
  try {
    const made = await publish(author, mod, [
      work('A', 'a'),
      work('Merged', 'b'),
      work('Gone', 'c'),
      work('Kept', 'd'),
      creator,
      directed('a'),
      directed('b'),
      directed('c'),
      directed('d'),
    ]);
    const [a, merged, gone, kept] = made.changes.slice(0, 4).map((c) => c.entityId!);
    await publish(author, mod, [{ op: 'merge', kind: 'work', from: merged, into: kept }]);
    await t.db.update(entities).set({ removedAt: new Date() }).where(eq(entities.id, gone!));
    const group = (await related(a!))!.byCreator[0]!;
    expect(group.works.map((w) => w.title)).toEqual(['Kept']);
  } finally {
    await t.close();
  }
});
