import { expect, it } from 'vitest';
import { type Created, publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (ref: string, subtype: string, title = ref, releaseYear?: number) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title, ...(releaseYear === undefined ? {} : { releaseYear }) },
});
const partOf = (parent: string, child: string, position?: number) => ({
  op: 'relate',
  type: 'work_part',
  from: { ref: parent },
  to: { ref: child },
  data: position === undefined ? {} : { position },
});
const merge = (from: string, into: string) => ({ op: 'merge', kind: 'work', from, into });

type Summary = { id: string; title: string };
type Ancestor = { id: string; title: string; subtype: string | null; position?: number; removed: boolean };
type Relations = {
  parent?: { relationId: string; work: Summary; position?: number; removed: boolean } | null;
  ancestors?: Ancestor[];
  partCount?: number;
} & Record<string, unknown>;
type Parts = {
  items: { relationId: string; work: Summary; subtype: string | null; position?: number }[];
  nextCursor: string | null;
};

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
  const relationsOf = async (id: string) => {
    const res = await anon.get(`/api/entities/${id}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { relations: Relations }).relations;
  };
  const partsPage = async (id: string, query = '') => {
    const res = await anon.get(`/api/entities/${id}/parts${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Parts;
  };
  const titlesOf = async (id: string) => (await partsPage(id)).items.map((p) => p.work.title);
  return { t, author, mod, admin, anon, idOf, relationsOf, partsPage, titlesOf };
}

/** A show with seasons numbered 2, 1 and 0, one with no number, and episodes 2, 0 and 1 under Season 2. */
async function tree(s: Awaited<ReturnType<typeof setup>>) {
  const made = await publish(s.author, s.mod, [
    work('show', 'series', 'Show'),
    work('s2', 'season', 'Season 2'),
    work('s1', 'season', 'Season 1'),
    work('s0', 'season', 'Specials'),
    work('sx', 'season', 'Unnumbered'),
    work('e2', 'episode', 'E2'),
    work('e0', 'episode', 'E0'),
    work('e1', 'episode', 'E1'),
    work('e14', 'episode', 'E14'),
    partOf('show', 's2', 2),
    partOf('show', 's1', 1),
    partOf('show', 's0', 0),
    partOf('show', 'sx'),
    partOf('s2', 'e2', 2),
    partOf('s2', 'e0', 0),
    partOf('s2', 'e1', 1),
    partOf('s2', 'e14', 14),
  ]);
  return {
    made,
    show: s.idOf(made, 0),
    s2: s.idOf(made, 1),
    e14: s.idOf(made, 8),
  };
}

it('episode shows its parent and ancestors', async () => {
  const s = await setup();
  try {
    const { show, s2, e14 } = await tree(s);
    const rel = await s.relationsOf(e14);
    expect(rel.parent?.work.title).toBe('Season 2');
    expect(rel.parent?.work.id).toBe(s2);
    expect(rel.parent?.position).toBe(14);
    expect(rel.parent?.removed).toBe(false);
    expect(rel.ancestors).toEqual([
      { id: show, title: 'Show', subtype: 'series', removed: false },
      { id: s2, title: 'Season 2', subtype: 'season', position: 2, removed: false },
    ]);
  } finally {
    await s.t.close();
  }
});

it('root has no parent', async () => {
  const s = await setup();
  try {
    const { show } = await tree(s);
    const rel = await s.relationsOf(show);
    expect(rel.parent).toBeNull();
    expect(rel.ancestors).toEqual([]);
  } finally {
    await s.t.close();
  }
});

it("show's entity view has partCount, not its parts", async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series', 'Show'),
      work('a', 'season', 'A'),
      work('b', 'season', 'B'),
      work('c', 'season', 'C'),
      partOf('show', 'a', 1),
      partOf('show', 'b', 2),
      partOf('show', 'c', 3),
    ]);
    const rel = await s.relationsOf(s.idOf(made, 0));
    expect(rel.partCount).toBe(3);
    const text = JSON.stringify(rel);
    for (const i of [1, 2, 3]) expect(text).not.toContain(s.idOf(made, i));
  } finally {
    await s.t.close();
  }
});

it('parts listed in order', async () => {
  const s = await setup();
  try {
    const { show, s2 } = await tree(s);
    expect(await s.titlesOf(show)).toEqual(['Season 1', 'Season 2', 'Unnumbered', 'Specials']);
    const page = await s.partsPage(show);
    expect(page.items.map((p) => [p.subtype, p.position])).toEqual([
      ['season', 1],
      ['season', 2],
      ['season', undefined],
      ['season', 0],
    ]);
    expect(page.nextCursor).toBeNull();
    expect(await s.titlesOf(s2)).toEqual(['E0', 'E1', 'E2', 'E14']);
  } finally {
    await s.t.close();
  }
});

it('ties break by date then title', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series', 'Show'),
      work('late', 'season', 'A late', 2009),
      work('early', 'season', 'B early', 2008),
      partOf('show', 'late'),
      partOf('show', 'early'),
    ]);
    expect(await s.titlesOf(s.idOf(made, 0))).toEqual(['B early', 'A late']);
  } finally {
    await s.t.close();
  }
});

it('parts cursor crosses every group', async () => {
  const s = await setup();
  try {
    const { show } = await tree(s);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=1${cursor ? `&cursor=${cursor}` : ''}`;
      const page = await s.partsPage(show, query);
      expect(page.items).toHaveLength(1);
      seen.push(...page.items.map((p) => p.work.title));
      cursor = page.nextCursor;
    } while (cursor && seen.length < 10);
    expect(seen).toEqual(['Season 1', 'Season 2', 'Unnumbered', 'Specials']);
  } finally {
    await s.t.close();
  }
});

it('parts of a removed show still resolve', async () => {
  const s = await setup();
  try {
    const { made, show, s2 } = await tree(s);
    const res = await s.admin.post(`/api/admin/changes/${made.changes[0]!.id}/redact`, {
      reason: 'Abuse',
      removeEntity: true,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const rel = await s.relationsOf(s2);
    expect(rel.parent?.removed).toBe(true);
    expect(rel.parent?.work.id).toBe(show);
    expect(rel.ancestors).toEqual([expect.objectContaining({ id: show, removed: true })]);
    const parts = await s.anon.get(`/api/entities/${show}/parts`);
    expect(parts.status).toBe(410);
    expect(((await parts.json()) as { error: { code: string } }).error.code).toBe('removed');
  } finally {
    await s.t.close();
  }
});

it('parts of a merged id redirect', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [work('a', 'series', 'A'), work('b', 'series', 'B')]);
    const [a, b] = [s.idOf(made, 0), s.idOf(made, 1)];
    await publish(s.author, s.mod, [merge(b, a)]);
    const res = await s.anon.get(`/api/entities/${b}/parts`);
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(`/api/entities/${a}/parts`);
    expect((await s.anon.get(`/api/entities/00000000-0000-4000-8000-000000000000/parts`)).status).toBe(404);
  } finally {
    await s.t.close();
  }
});

it('a non-work has no parts', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      { op: 'create', kind: 'tag', ref: 'tg', fields: { kind: 'genre', name: 'Noir', slug: 'noir' } },
    ]);
    expect(await s.partsPage(s.idOf(made, 0))).toEqual({ items: [], nextCursor: null });
  } finally {
    await s.t.close();
  }
});
