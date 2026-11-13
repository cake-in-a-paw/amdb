import { expect, it } from 'vitest';
import { type Created, publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

type End = { ref: string } | { id: string };
const end = (x: string | End): End => (typeof x === 'string' ? { ref: x } : x);
const work = (ref: string, subtype: string, title = ref) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title },
});
const creator = (ref: string, name = ref) => ({ op: 'create', kind: 'creator', ref, fields: { kind: 'person', name } });
const partOf = (parent: string, child: string, position: number) => ({
  op: 'relate',
  type: 'work_part',
  from: { ref: parent },
  to: { ref: child },
  data: { position },
});
const credit = (w: string | End, c: string | End, role: string) => ({
  op: 'relate',
  type: 'work_creator',
  from: end(w),
  to: end(c),
  data: { role },
});

type Credit = { work: { id: string; title: string }; removed: boolean; roles: string[]; parts: Record<string, number> };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin' }) });
  const anon = t.as({ kind: 'none' });
  const idOf = (created: Created, i: number) => {
    const id = created.changes[i]?.entityId;
    if (!id) throw new Error(`change ${i} has no entity`);
    return id;
  };
  const changeOf = (created: Created, i: number) => {
    const id = created.changes[i]?.id;
    if (!id) throw new Error(`no change ${i}`);
    return id;
  };
  const removeEntity = async (createChangeId: string) => {
    const res = await admin.post(`/api/admin/changes/${createChangeId}/redact`, {
      reason: 'Abuse',
      removeEntity: true,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const creditsOf = async (id: string) => {
    const res = await anon.get(`/api/entities/${id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { relations: { credits?: Credit[] } }).relations.credits;
  };
  return { t, author, mod, idOf, changeOf, removeEntity, creditsOf };
}

const byTitle = (credits: Credit[] | undefined) =>
  (credits ?? []).toSorted((a, b) => a.work.title.localeCompare(b.work.title));

/**
 * Creator C; film F; show S with seasons S1 and S2, episodes E11 and E12 under S1, E21 under S2,
 * episode X directly under S; and orphan episode O. C is credited on F (twice), S, S2, every
 * episode under S, and O.
 */
async function fixture(s: Awaited<ReturnType<typeof setup>>) {
  const made = await publish(s.author, s.mod, [
    creator('C'),
    work('F', 'movie'),
    work('S', 'series'),
    work('S1', 'season'),
    work('S2', 'season'),
    work('E11', 'episode'),
    work('E12', 'episode'),
    work('E21', 'episode'),
    work('X', 'episode'),
    work('O', 'episode'),
    partOf('S', 'S1', 1),
    partOf('S', 'S2', 2),
    partOf('S1', 'E11', 1),
    partOf('S1', 'E12', 2),
    partOf('S2', 'E21', 1),
    partOf('S', 'X', 5),
    credit('F', 'C', 'director'),
    credit('S', 'C', 'producer'),
    credit('E11', 'C', 'writer'),
    credit('E12', 'C', 'director'),
    credit('E21', 'C', 'director'),
    credit('S2', 'C', 'director'),
    credit('X', 'C', 'director'),
    credit('O', 'C', 'writer'),
    credit('F', 'C', 'writer'),
  ]);
  return {
    c: s.idOf(made, 0),
    f: s.idOf(made, 1),
    show: s.idOf(made, 2),
    o: s.idOf(made, 9),
    fCreate: s.changeOf(made, 1),
    showCreate: s.changeOf(made, 2),
  };
}

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
