import { expect, it } from 'vitest';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (title: string, extra: Record<string, unknown> = {}, mediaType = 'film_tv') => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType, subtype: mediaType === 'film_tv' ? 'movie' : null, title, ...extra },
});

type Summary = { id: string; kind: string; title: string; mediaType?: string; releaseYear?: number };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  const search = async (qs: string) => {
    const res = await anon.get(`/api/search?${qs}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { items: Summary[]; nextCursor: string | null };
  };
  return { t, author, mod, anon, search };
}

it('"amelie" finds "  Amélie "', async () => {
  const { t, author, mod, search } = await setup();
  try {
    const created = await publish(author, mod, [work('  Amélie ', { releaseYear: 2001 })]);
    const { items } = await search('q=amelie');
    expect(items).toEqual([
      { id: created.changes[0]!.entityId, kind: 'work', title: 'Amélie', mediaType: 'film_tv', releaseYear: 2001 },
    ]);
    expect((await search('q=AMÉLIE')).items).toHaveLength(1);
  } finally {
    await t.close();
  }
});

it('search matches a prefix on the last term, in any word order, and filters by kind and media type', async () => {
  const { t, author, mod, search } = await setup();
  try {
    await publish(author, mod, [
      work('The Lord of the Rings'),
      { ...work('The Lord of the Flies', {}, 'book'), ref: 'b' },
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Lord Dunsany', kind: 'person' } },
    ]);
    expect((await search('q=lord+of+the+ri')).items.map((i) => i.title)).toEqual(['The Lord of the Rings']);
    expect((await search('q=rings+lord')).items.map((i) => i.title)).toEqual(['The Lord of the Rings']);
    expect((await search('q=lord')).items.map((i) => i.title).toSorted()).toEqual([
      'Lord Dunsany',
      'The Lord of the Flies',
      'The Lord of the Rings',
    ]);
    expect((await search('q=lord&kind=creator')).items.map((i) => i.title)).toEqual(['Lord Dunsany']);
    expect((await search('q=lord&mediaType=book')).items.map((i) => i.title)).toEqual(['The Lord of the Flies']);
    expect((await search('q=dunsa')).items.map((i) => i.title)).toEqual(['Lord Dunsany']);
    expect((await search('q=%25')).items).toEqual([]);
    expect((await search('q=:*|!(')).items).toEqual([]);
  } finally {
    await t.close();
  }
});

it('search pages through results with a cursor', async () => {
  const { t, author, mod, search } = await setup();
  try {
    await publish(
      author,
      mod,
      ['A', 'B', 'C'].map((s, i) => ({ ...work(`Saga ${s}`), ref: `w${i}` })),
    );
    const first = await search('q=saga&limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await search(`q=saga&limit=2&cursor=${first.nextCursor}`);
    expect([...first.items, ...second.items].map((i) => i.title)).toEqual(['Saga A', 'Saga B', 'Saga C']);
    expect(second.nextCursor).toBeNull();
  } finally {
    await t.close();
  }
});

it('search leaves out pending and retracted entities', async () => {
  const { t, author, mod, search } = await setup();
  try {
    await submit(author, [work('Pending Film')]);
    const live = await publish(author, mod, [work('Live Film')]);
    expect((await search('q=film')).items.map((i) => i.title)).toEqual(['Live Film']);
    expect((await mod.post(`/api/changes/${live.changes[0]!.id}/revert`)).status).toBe(200);
    expect((await search('q=film')).items).toEqual([]);
  } finally {
    await t.close();
  }
});

it.todo('search skips merged entities');

it('duplicates shows a pending create’s title, mediaType and year, and nothing else', async () => {
  const { t, author, mod, anon } = await setup();
  try {
    await publish(author, mod, [work('Arrival', { releaseYear: 2016 })]);
    await submit(author, [work('Arrival (extended cut)', { releaseYear: 2017, description: 'secret note' })]);
    const res = await anon.get('/api/duplicates?kind=work&title=arrival');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { existing: Summary[]; pending: Record<string, unknown>[] };
    expect(body.existing.map((e) => e.title)).toEqual(['Arrival']);
    expect(body.pending).toHaveLength(1);
    expect(Object.keys(body.pending[0]!).toSorted()).toEqual(['kind', 'mediaType', 'releaseYear', 'title']);
    expect(body.pending[0]).toEqual({
      kind: 'work',
      title: 'Arrival (extended cut)',
      mediaType: 'film_tv',
      releaseYear: 2017,
    });
    expect(JSON.stringify(body)).not.toContain('secret note');
  } finally {
    await t.close();
  }
});

it('duplicates ignores rejected creates and other media types, and covers creators', async () => {
  const { t, author, mod, anon } = await setup();
  try {
    const rejected = await submit(author, [work('Dune')]);
    await mod.post(`/api/changes/${rejected.changes[0]!.id}/reject`, { reason: 'x' });
    await submit(author, [{ ...work('Dune', {}, 'book'), ref: 'b' }]);
    await submit(author, [
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Dune Person', kind: 'person' } },
    ]);
    const get = async (qs: string) =>
      (await (await anon.get(`/api/duplicates?${qs}`)).json()) as { pending: Record<string, unknown>[] };
    expect((await get('kind=work&title=dune&mediaType=film_tv')).pending).toEqual([]);
    expect((await get('kind=work&title=dune&mediaType=book')).pending).toHaveLength(1);
    expect((await get('kind=creator&title=dune')).pending).toEqual([
      { kind: 'creator', title: 'Dune Person', mediaType: null, releaseYear: null },
    ]);
  } finally {
    await t.close();
  }
});

it('duplicates finds a pending create titled "  Amélie " by "amelie", with the same matching as existing', async () => {
  const { t, author, mod, anon } = await setup();
  try {
    await submit(author, [work('  Amélie ', { releaseYear: 2001 })]);
    await publish(author, mod, [{ ...work('Amélie Poulain'), ref: 'x' }]);
    const body = (await (await anon.get('/api/duplicates?kind=work&title=amelie')).json()) as {
      existing: Summary[];
      pending: Record<string, unknown>[];
    };
    expect(body.pending).toEqual([{ kind: 'work', title: 'Amélie', mediaType: 'film_tv', releaseYear: 2001 }]);
    expect(body.existing.map((e) => e.title)).toEqual(['Amélie Poulain']);
  } finally {
    await t.close();
  }
});

it('a mediaType with a kind other than work is a 400', async () => {
  const { t, anon } = await setup();
  try {
    for (const path of [
      '/api/search?q=x&kind=creator&mediaType=book',
      '/api/duplicates?kind=creator&title=x&mediaType=book',
    ]) {
      const res = await anon.get(path);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  } finally {
    await t.close();
  }
});
