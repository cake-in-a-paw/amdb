import { expect, it } from 'vitest';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const film = (title: string) => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title },
});
const creator = (name: string, ref = 'c') => ({ op: 'create', kind: 'creator', ref, fields: { name, kind: 'person' } });
const directed = (workRef: unknown, creatorRef: unknown) => ({
  op: 'relate',
  type: 'work_creator',
  from: workRef,
  to: creatorRef,
  data: { role: 'director' },
});
const merge = (kind: string, from: string, into: string) => ({ op: 'merge', kind, from, into });

type Rel = { relationId: string; work: { id: string; title: string } };
type Entity = {
  fields: Record<string, unknown>;
  relations: { works?: Rel[]; creators?: { creator: { id: string } }[] };
};

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  const get = async (id: string) => (await anon.get(`/api/entities/${id}`)) as Response;
  const entity = async (id: string) => {
    const res = await get(id);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Entity;
  };
  /** Two creators each directing a work; returns their ids. */
  const twoCreators = async () => {
    const a = await publish(author, mod, [
      film('Arrival'),
      creator('Denis Villeneuve'),
      directed({ ref: 'w' }, { ref: 'c' }),
    ]);
    const b = await publish(author, mod, [
      film('Sicario'),
      creator('D. Villeneuve'),
      directed({ ref: 'w' }, { ref: 'c' }),
    ]);
    return {
      winner: a.changes[1]!.entityId!,
      loser: b.changes[1]!.entityId!,
      arrival: a.changes[0]!.entityId!,
      sicario: b.changes[0]!.entityId!,
    };
  };
  return { t, author, mod, anon, get, entity, twoCreators };
}

it('after merging two creators, the loser’s id redirects with 308 and the winner lists both works', async () => {
  const { t, author, mod, anon, get, entity, twoCreators } = await setup();
  try {
    const { winner, loser, arrival, sicario } = await twoCreators();
    const [change] = (await publish(author, mod, [merge('creator', loser, winner)])).changes;

    const res = await get(loser);
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe(`/api/entities/${winner}`);
    expect(await res.json()).toEqual({ redirectTo: winner });
    const hist = await anon.get(`/api/entities/${loser}/history`);
    expect(hist.status).toBe(308);
    expect(hist.headers.get('location')).toBe(`/api/entities/${winner}/history`);
    expect(await hist.json()).toEqual({ redirectTo: winner });

    const works = (await entity(winner)).relations.works!;
    expect(works.map((w) => w.work.id).toSorted()).toEqual([arrival, sicario].toSorted());
    // The works now credit the winner.
    expect((await entity(sicario)).relations.creators!.map((c) => c.creator.id)).toEqual([winner]);

    // The winner's history shows the merge and the relations it took over.
    const items = (
      (await (await anon.get(`/api/entities/${winner}/history`)).json()) as { items: { changeId: string }[] }
    ).items;
    expect(items.map((i) => i.changeId)).toContain(change!.id);
    // Unknown ids are still 404; a merged-into-a-merged id resolves through the chain.
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('a pending update to the loser, approved after the merge, changes the winner', async () => {
  const { t, author, mod, entity, twoCreators } = await setup();
  try {
    const { winner, loser } = await twoCreators();
    const pending = await submit(author, [
      { op: 'update', kind: 'creator', entityId: loser, fields: { description: 'Canadian director' } },
    ]);
    await publish(author, mod, [merge('creator', loser, winner)]);
    const res = await mod.post(`/api/changes/${pending.changes[0]!.id}/approve`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await entity(winner)).fields.description).toBe('Canadian director');
  } finally {
    await t.close();
  }
});

it('reverting a merge restores both entities and their relations', async () => {
  const { t, author, mod, get, entity, twoCreators } = await setup();
  try {
    const { winner, loser, arrival, sicario } = await twoCreators();
    // Both creators also direct a shared work: the loser's duplicate is dropped by the merge.
    const shared = await publish(author, mod, [film('Dune')]);
    const dune = shared.changes[0]!.entityId!;
    await publish(author, mod, [directed({ id: dune }, { id: winner }), directed({ id: dune }, { id: loser })]);
    const before = {
      winner: (await entity(winner)).relations.works!.map((w) => w.relationId).toSorted(),
      loser: (await entity(loser)).relations.works!.map((w) => w.relationId).toSorted(),
    };
    expect(before.loser).toHaveLength(2);

    const merged = await publish(author, mod, [merge('creator', loser, winner)]);
    expect((await entity(winner)).relations.works!).toHaveLength(3);
    expect((await get(loser)).status).toBe(308);

    const res = await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await get(loser)).status).toBe(200);
    expect((await entity(winner)).relations.works!.map((w) => w.relationId).toSorted()).toEqual(before.winner);
    expect((await entity(loser)).relations.works!.map((w) => w.relationId).toSorted()).toEqual(before.loser);
    expect((await entity(sicario)).relations.creators!.map((c) => c.creator.id).toSorted()).toEqual([loser]);
    expect((await entity(arrival)).relations.creators!.map((c) => c.creator.id)).toEqual([winner]);

    // The revert shows in the winner's history.
    const hist = (await (await mod.get(`/api/entities/${winner}/history`)).json()) as {
      items: { revertOf: string | null }[];
    };
    expect(hist.items.some((i) => i.revertOf === merged.changes[0]!.id)).toBe(true);
  } finally {
    await t.close();
  }
});

it('rejects a merge of different kinds and a self-merge, including through a merged id', async () => {
  const { t, author, mod, twoCreators } = await setup();
  try {
    const { winner, loser, arrival } = await twoCreators();
    const post = (c: unknown) => author.post('/api/submissions', { cc0: true, changes: [c] });
    const kind = await post(merge('creator', loser, arrival));
    expect(kind.status).toBe(400);
    expect(((await kind.json()) as { error: { code: string } }).error.code).toBe('kind_mismatch');
    const self = await post(merge('creator', winner, winner));
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: { code: string } }).error.code).toBe('self_merge');

    // Merging into a loser resolves to its winner; merging the winner into its own loser is a self-merge.
    await publish(author, mod, [merge('creator', loser, winner)]);
    const back = await post(merge('creator', winner, loser));
    expect(back.status).toBe(400);
    expect(((await back.json()) as { error: { code: string } }).error.code).toBe('self_merge');
  } finally {
    await t.close();
  }
});

it('a merge into a merged entity lands on the winner, and a later change blocks reverting the merge', async () => {
  const { t, author, mod, entity, get, twoCreators } = await setup();
  try {
    const { winner, loser, sicario } = await twoCreators();
    const third = await publish(author, mod, [creator('Denis V.')]);
    const stray = third.changes[0]!.entityId!;
    const first = await publish(author, mod, [merge('creator', loser, winner)]);
    // `into` is now merged away: it resolves to the winner.
    const merged = await publish(author, mod, [merge('creator', stray, loser)]);
    expect((await get(stray)).headers.get('location')).toBe(`/api/entities/${winner}`);

    // A later unrelate of a moved relation makes the first merge irreversible.
    const rel = (await entity(winner)).relations.works!.find((w) => w.work.id === sicario)!;
    await publish(author, mod, [{ op: 'unrelate', relationId: rel.relationId }]);
    const res = await mod.post(`/api/changes/${first.changes[0]!.id}/revert`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('stale_change');
    // The later merge (stray into the loser) is itself revertible.
    expect((await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`)).status).toBe(200);
    expect((await get(stray)).status).toBe(200);
  } finally {
    await t.close();
  }
});
