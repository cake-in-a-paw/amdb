import { expect, it } from 'vitest';
import { publish } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const film = {
  op: 'create',
  kind: 'work',
  ref: 'film',
  fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival', releaseYear: 2016 },
};
const novel = {
  op: 'create',
  kind: 'work',
  ref: 'novel',
  fields: { mediaType: 'book', subtype: null, title: 'Story of Your Life', releaseYear: 1998 },
};

type Summary = { id: string; kind: string; title: string; mediaType?: string; releaseYear?: number };
type Entity = {
  relations: {
    links?: { relationId: string; type: string; direction: string; work: Summary }[];
    externalIds?: { scheme: string; value: string }[];
  };
};

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const get = async (id: string) => {
    const res = await t.as({ kind: 'none' }).get(`/api/entities/${id}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Entity;
  };
  return { t, author, mod, get };
}

it('an outgoing adapted_from link appears as incoming on the novel', async () => {
  const { t, author, mod, get } = await setup();
  try {
    const created = await publish(author, mod, [
      film,
      novel,
      {
        op: 'relate',
        type: 'work_link',
        from: { ref: 'film' },
        to: { ref: 'novel' },
        data: { linkType: 'adapted_from' },
      },
    ]);
    const filmId = created.changes[0]!.entityId!;
    const novelId = created.changes[1]!.entityId!;

    expect((await get(filmId)).relations.links).toEqual([
      {
        relationId: expect.any(String),
        type: 'adapted_from',
        direction: 'outgoing',
        work: { id: novelId, kind: 'work', title: 'Story of Your Life', mediaType: 'book', releaseYear: 1998 },
      },
    ]);
    expect((await get(novelId)).relations.links).toEqual([
      {
        relationId: expect.any(String),
        type: 'adapted_from',
        direction: 'incoming',
        work: { id: filmId, kind: 'work', title: 'Arrival', mediaType: 'film_tv', releaseYear: 2016 },
      },
    ]);
  } finally {
    await t.close();
  }
});

it('external ids are listed', async () => {
  const { t, author, mod, get } = await setup();
  try {
    const created = await publish(author, mod, [
      film,
      { op: 'relate', type: 'external_id', from: { ref: 'film' }, data: { scheme: 'wikidata', value: 'Q20819016' } },
      { op: 'relate', type: 'external_id', from: { ref: 'film' }, data: { scheme: 'imdb', value: 'tt2543164' } },
    ]);
    const entity = await get(created.changes[0]!.entityId!);
    expect(
      entity.relations.externalIds
        ?.map(({ scheme, value }) => ({ scheme, value }))
        .toSorted((a, b) => a.scheme.localeCompare(b.scheme)),
    ).toEqual([
      { scheme: 'imdb', value: 'tt2543164' },
      { scheme: 'wikidata', value: 'Q20819016' },
    ]);
  } finally {
    await t.close();
  }
});

it('an unknown id is 404 with the error shape', async () => {
  const { t } = await setup();
  try {
    const res = await t.as({ kind: 'none' }).get(`/api/entities/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  } finally {
    await t.close();
  }
});
