import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { entities } from '../src/platform/db/schema';
import { publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (title: string, ref: string, mediaType = 'film_tv') => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType, subtype: mediaType === 'film_tv' ? 'movie' : null, title },
});

type Page = { items: { id: string; kind: string; title: string }[]; nextCursor: string | null };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  const browse = async (qs: string) => {
    const res = await anon.get(`/api/browse?${qs}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Page;
  };
  return { t, author, mod, anon, browse };
}

it('lists works in title order and pages with a cursor', async () => {
  const { t, author, mod, browse } = await setup();
  try {
    await publish(author, mod, [work('Charlie', 'a'), work('Alpha', 'b'), work('Bravo', 'c')]);
    expect((await browse('kind=work')).items.map((i) => i.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    const first = await browse('kind=work&limit=2');
    expect(first.items.map((i) => i.title)).toEqual(['Alpha', 'Bravo']);
    expect(first.nextCursor).toBeTruthy();
    const second = await browse(`kind=work&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.title)).toEqual(['Charlie']);
    expect(second.nextCursor).toBeNull();
  } finally {
    await t.close();
  }
});

it('filters by kind and media type', async () => {
  const { t, author, mod, browse } = await setup();
  try {
    await publish(author, mod, [
      work('Film', 'a'),
      work('Book', 'b', 'book'),
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Ada', kind: 'person' } },
    ]);
    expect((await browse('kind=creator')).items.map((i) => i.title)).toEqual(['Ada']);
    expect((await browse('kind=work&mediaType=book')).items.map((i) => i.title)).toEqual(['Book']);
  } finally {
    await t.close();
  }
});

it('never lists merged, retracted or removed entities', async () => {
  const { t, author, mod, browse } = await setup();
  try {
    const made = await publish(author, mod, [
      work('Kept', 'a'),
      work('Merged away', 'b'),
      work('Retracted', 'c'),
      work('Removed', 'd'),
    ]);
    const [kept, merged, , removed] = made.changes.map((c) => c.entityId!);
    await publish(author, mod, [{ op: 'merge', kind: 'work', from: merged, into: kept }]);
    expect((await mod.post(`/api/changes/${made.changes[2]!.id}/revert`)).status).toBe(200);
    await t.db.update(entities).set({ removedAt: new Date() }).where(eq(entities.id, removed!));
    expect((await browse('kind=work')).items.map((i) => i.id)).toEqual([kept]);
  } finally {
    await t.close();
  }
});

it('requires a kind, and a mediaType only with kind=work', async () => {
  const { t, anon } = await setup();
  try {
    for (const qs of ['mediaType=book&kind=creator', 'limit=2']) {
      const res = await anon.get(`/api/browse?${qs}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    }
  } finally {
    await t.close();
  }
});

const node = (ref: string, subtype: string, title: string) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title },
});
const partOf = (parent: string, child: string, position: number) => ({
  op: 'relate',
  type: 'work_part',
  from: { ref: parent },
  to: { ref: child },
  data: { position },
});

it('browse lists no seasons or episodes', async () => {
  const { t, author, mod, browse } = await setup();
  try {
    await publish(author, mod, [
      node('show', 'series', 'Show'),
      node('season', 'season', 'Season 1'),
      node('ep', 'episode', 'Episode 1'),
      partOf('show', 'season', 1),
      partOf('season', 'ep', 1),
    ]);
    expect((await browse('kind=work&mediaType=film_tv')).items.map((i) => i.title)).toEqual(['Show']);
  } finally {
    await t.close();
  }
});

it('an orphaned season stays out of search and browse', async () => {
  const { t, author, mod, anon, browse } = await setup();
  try {
    const made = await publish(author, mod, [
      node('show', 'series', 'Show'),
      node('season', 'season', 'Season 1'),
      partOf('show', 'season', 1),
    ]);
    const season = made.changes[1]!.entityId!;
    const view = (await (await anon.get(`/api/entities/${season}`)).json()) as {
      relations: { parent: { relationId: string } | null };
    };
    await publish(author, mod, [{ op: 'unrelate', relationId: view.relations.parent!.relationId }]);
    const search = async (qs: string) => {
      const res = await anon.get(`/api/search?${qs}`);
      expect(res.status, await res.clone().text()).toBe(200);
      return ((await res.json()) as { items: { id: string; part?: unknown }[] }).items;
    };
    expect(await search('q=season')).toEqual([]);
    expect((await browse('kind=work&mediaType=film_tv')).items.map((i) => i.title)).toEqual(['Show']);
    // Asked for, it's found, with no part context: it has no live parent.
    const found = await search('q=season&includeParts=true');
    expect(found.map((i) => i.id)).toEqual([season]);
    expect(found[0]).not.toHaveProperty('part');
  } finally {
    await t.close();
  }
});
