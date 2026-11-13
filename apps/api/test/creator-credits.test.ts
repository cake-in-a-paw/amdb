import { expect, it } from 'vitest';
import { publish } from './helpers/catalog';
import { creator, credit, creditsFixture as fixture, partOf, setupCredits, work } from './helpers/creator-credits';

type Credit = { work: { id: string; title: string }; removed: boolean; roles: string[]; parts: Record<string, number> };

async function setup() {
  const s = await setupCredits();
  const creditsOf = async (id: string) => {
    const res = await s.anon.get(`/api/entities/${id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { relations: { credits?: Credit[] } }).relations.credits;
  };
  return { ...s, creditsOf };
}

const byTitle = (credits: Credit[] | undefined) =>
  (credits ?? []).toSorted((a, b) => a.work.title.localeCompare(b.work.title));

it("a creator's credits group parts under their show", async () => {
  const s = await setup();
  try {
    const { c, f, show, o } = await fixture(s);
    expect(byTitle(await s.creditsOf(c))).toEqual([
      { work: expect.objectContaining({ id: f }), removed: false, roles: ['director', 'writer'], parts: {} },
      { work: expect.objectContaining({ id: o }), removed: false, roles: ['writer'], parts: {} },
      {
        work: expect.objectContaining({ id: show }),
        removed: false,
        roles: ['director', 'writer', 'producer'],
        parts: { season: 1, episode: 4 },
      },
    ]);
  } finally {
    await s.t.close();
  }
});

it("credits keep the order of each row's earliest credit", async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      creator('C'),
      work('F', 'movie'),
      work('S', 'series'),
      work('S1', 'season'),
      work('E11', 'episode'),
      partOf('S', 'S1', 1),
      partOf('S1', 'E11', 1),
    ]);
    const [c, f, show, e11] = [0, 1, 2, 4].map((i) => ({ id: s.idOf(made, i) }));
    if (!c || !f || !show || !e11) throw new Error('fixture is missing an entity');
    await publish(s.author, s.mod, [credit(e11, c, 'writer')]);
    await publish(s.author, s.mod, [credit(f, c, 'director')]);
    await publish(s.author, s.mod, [credit(show, c, 'producer')]);
    expect((await s.creditsOf(c.id))?.map((x) => x.work.id)).toEqual([show.id, f.id]);
  } finally {
    await s.t.close();
  }
});

it('credits order is stable across calls', async () => {
  const s = await setup();
  try {
    const { c } = await fixture(s);
    const first = await s.creditsOf(c);
    expect(first).toHaveLength(3);
    expect(await s.creditsOf(c)).toEqual(first);
  } finally {
    await s.t.close();
  }
});

it('a removed show keeps its row, marked removed', async () => {
  const s = await setup();
  try {
    const { c, show, showCreate } = await fixture(s);
    await s.removeEntity(showCreate);
    const row = (await s.creditsOf(c))?.find((x) => x.work.id === show);
    expect(row).toEqual({
      // A removal erases the work's free text, so its stored title is the placeholder, not 'S'.
      work: expect.objectContaining({ id: show, title: '[removed]' }),
      removed: true,
      roles: ['director', 'writer'],
      parts: { season: 1, episode: 4 },
    });
  } finally {
    await s.t.close();
  }
});

it('a removed film drops out, as today', async () => {
  const s = await setup();
  try {
    const { c, f, fCreate } = await fixture(s);
    await s.removeEntity(fCreate);
    const ids = (await s.creditsOf(c))?.map((x) => x.work.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(f);
  } finally {
    await s.t.close();
  }
});

it('only creators trade works for credits', async () => {
  const s = await setup();
  try {
    const { c, f } = await fixture(s);
    const made = await publish(s.author, s.mod, [
      { op: 'create', kind: 'series', ref: 'x', fields: { title: 'X' } },
      { op: 'relate', type: 'series_work', from: { ref: 'x' }, to: { id: f }, data: { position: 1 } },
    ]);
    const relationsOf = async (id: string) => {
      const res = await s.anon.get(`/api/entities/${id}`);
      expect(res.status, await res.clone().text()).toBe(200);
      type Relations = { works?: { work: { id: string } }[]; credits?: unknown[] };
      return ((await res.json()) as { relations: Relations }).relations;
    };
    const ofCreator = await relationsOf(c);
    expect(ofCreator.works).toBeUndefined();
    expect(ofCreator.credits).toHaveLength(3);
    expect((await relationsOf(s.idOf(made, 0))).works?.map((w) => w.work.id)).toEqual([f]);
  } finally {
    await s.t.close();
  }
});
