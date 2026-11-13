import { expect, it } from 'vitest';
import { publish } from './helpers/catalog';
import { creator, credit, creditsFixture as fixture, partOf, setupCredits, work } from './helpers/creator-credits';

type Item = { work: { id: string; title: string; part?: unknown }; roles: string[] };
type Page = {
  under: { work: { id: string; title: string }; removed: boolean };
  items: Item[];
  nextCursor: string | null;
};

async function setup() {
  const s = await setupCredits();
  const creditsUnder = async (id: string, workId: string, query = '') => {
    const res = await s.anon.get(`/api/entities/${id}/credits/${workId}${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Page;
  };
  return { ...s, creditsUnder };
}

const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

it("a show's credits list depth-first, seasons first", async () => {
  const s = await setup();
  try {
    const { c, show, s1, s2, e11, e12, e21, x } = await fixture(s);
    const page = await s.creditsUnder(c, show);
    expect(page.items.map((i) => i.work.id)).toEqual([show, e11, e12, s2, e21, x]);
    expect(page.items.map((i) => i.roles)).toEqual([
      ['producer'],
      ['writer'],
      ['director'],
      ['director'],
      ['director'],
      ['director'],
    ]);
    expect(page.items[0]?.work.part).toBeUndefined();
    expect(page.items[1]?.work.part).toEqual({
      subtype: 'episode',
      position: 1,
      ancestors: [
        { id: show, title: 'S', subtype: 'series', removed: false },
        { id: s1, title: 'S1', subtype: 'season', position: 1, removed: false },
      ],
    });
    expect(page.under).toEqual({ work: expect.objectContaining({ id: show }), removed: false });
    expect(page.nextCursor).toBeNull();
  } finally {
    await s.t.close();
  }
});

it("a show's own episodes follow its seasons whatever their number, and a removed season keeps its place", async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      creator('C'),
      work('T', 'series'),
      work('T2', 'season'),
      work('Y', 'episode'),
      work('Z', 'episode'),
      partOf('T', 'T2', 2),
      partOf('T', 'Y', 1),
      partOf('T2', 'Z', 1),
      credit('Y', 'C', 'writer'),
      credit('Z', 'C', 'writer'),
    ]);
    const [c, show, y, z] = [0, 1, 3, 4].map((i) => s.idOf(made, i));
    if (!c || !show) throw new Error('fixture is missing an entity');
    expect((await s.creditsUnder(c, show)).items.map((i) => i.work.id)).toEqual([z, y]);
    await s.removeEntity(s.changeOf(made, 2));
    expect((await s.creditsUnder(c, show)).items.map((i) => i.work.id)).toEqual([z, y]);
  } finally {
    await s.t.close();
  }
});

it('paging returns each credit once, in order', async () => {
  const s = await setup();
  try {
    const { c, show } = await fixture(s);
    const all = (await s.creditsUnder(c, show)).items.map((i) => i.work.id);
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 20; n++) {
      const page: Page = await s.creditsUnder(c, show, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      paged.push(...page.items.map((i) => i.work.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(paged).toEqual(all);
  } finally {
    await s.t.close();
  }
});

it("a removed show's episodes stay reachable", async () => {
  const s = await setup();
  try {
    const { c, show, s2, e11, e12, e21, x, showCreate } = await fixture(s);
    await s.removeEntity(showCreate);
    const page = await s.creditsUnder(c, show);
    expect(page.under).toEqual({
      // A removal erases the work's free text, so its stored title is the placeholder.
      work: expect.objectContaining({ id: show, title: '[removed]' }),
      removed: true,
    });
    expect(page.items.map((i) => i.work.id)).toEqual([e11, e12, s2, e21, x]);
  } finally {
    await s.t.close();
  }
});

it('a merged creator redirects', async () => {
  const s = await setup();
  try {
    const { c, show } = await fixture(s);
    const c2 = s.idOf(await publish(s.author, s.mod, [creator('C2')]), 0);
    await publish(s.author, s.mod, [{ op: 'merge', kind: 'creator', from: c, into: c2 }]);
    const res = await s.anon.get(`/api/entities/${c}/credits/${show}`);
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(`/api/entities/${c2}/credits/${show}`);
  } finally {
    await s.t.close();
  }
});

it('unknown work is 404', async () => {
  const s = await setup();
  try {
    const { c } = await fixture(s);
    const res = await s.anon.get(`/api/entities/${c}/credits/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  } finally {
    await s.t.close();
  }
});

it('a non-creator has no credits', async () => {
  const s = await setup();
  try {
    const { f, show } = await fixture(s);
    const page = await s.creditsUnder(f, show);
    expect(page).toEqual({ under: expect.objectContaining({ removed: false }), items: [], nextCursor: null });
  } finally {
    await s.t.close();
  }
});

it('a bad cursor is 400', async () => {
  const s = await setup();
  try {
    const { c, show } = await fixture(s);
    const res = await s.anon.get(`/api/entities/${c}/credits/${show}?cursor=nope`);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_cursor');
  } finally {
    await s.t.close();
  }
});
