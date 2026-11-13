import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { entities } from '../src/platform/db/schema';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const film = (title: string) => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title },
});
const creator = (name: string, ref = 'c', extra: Record<string, unknown> = {}) => ({
  op: 'create',
  kind: 'creator',
  ref,
  fields: { name, kind: 'person', ...extra },
});
const directed = (workRef: unknown, creatorRef: unknown) => ({
  op: 'relate',
  type: 'work_creator',
  from: workRef,
  to: creatorRef,
  data: { role: 'director' },
});
const merge = (kind: string, from: string, into: string) => ({ op: 'merge', kind, from, into });

type Entity = {
  fields: Record<string, unknown>;
  relations: {
    credits?: { work: { id: string } }[];
    creators?: { relationId: string; creator: { id: string } }[];
  };
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
  /** The ids of the works creator `id` is credited on. */
  const creditedWorks = async (id: string) => (await entity(id)).relations.credits!.map((c) => c.work.id);
  /** The ids of creator `id`'s credit relations on each of `workIds`, read from the works' side. */
  const creditIds = async (id: string, workIds: string[]) =>
    (
      await Promise.all(
        workIds.map(async (w) =>
          (await entity(w)).relations.creators!.filter((c) => c.creator.id === id).map((c) => c.relationId),
        ),
      )
    )
      .flat()
      .toSorted();
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
  return { t, author, mod, anon, get, entity, creditedWorks, creditIds, twoCreators };
}

it('after merging two creators, the loser’s id redirects with 308 and the winner lists both works', async () => {
  const { t, author, mod, anon, get, entity, creditedWorks, twoCreators } = await setup();
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

    expect((await creditedWorks(winner)).toSorted()).toEqual([arrival, sicario].toSorted());
    // The works now credit the winner.
    expect((await entity(sicario)).relations.creators!.map((c) => c.creator.id)).toEqual([winner]);

    // The winner's history shows the merge and the relations it took over.
    const items = (
      (await (await anon.get(`/api/entities/${winner}/history`)).json()) as { items: { changeId: string }[] }
    ).items;
    expect(items.map((i) => i.changeId)).toContain(change!.id);
    // Unknown ids are still 404.
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
  const { t, author, mod, get, entity, creditIds, twoCreators } = await setup();
  try {
    const { winner, loser, arrival, sicario } = await twoCreators();
    // Both creators also direct a shared work: the loser's duplicate is dropped by the merge.
    const shared = await publish(author, mod, [film('Dune')]);
    const dune = shared.changes[0]!.entityId!;
    await publish(author, mod, [directed({ id: dune }, { id: winner }), directed({ id: dune }, { id: loser })]);
    const all = [arrival, sicario, dune];
    const before = { winner: await creditIds(winner, all), loser: await creditIds(loser, all) };
    expect(before.loser).toHaveLength(2);

    const merged = await publish(author, mod, [merge('creator', loser, winner)]);
    // Three credit relations, not four: the loser's duplicate Dune credit was dropped.
    expect(await creditIds(winner, all)).toHaveLength(3);
    expect((await get(loser)).status).toBe(308);

    const res = await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await get(loser)).status).toBe(200);
    expect(await creditIds(winner, all)).toEqual(before.winner);
    expect(await creditIds(loser, all)).toEqual(before.loser);
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

it('the winner’s history includes the loser’s own changes and updates that named the loser', async () => {
  const { t, author, mod, anon, twoCreators } = await setup();
  try {
    const { winner, loser } = await twoCreators();
    const pending = await submit(author, [
      { op: 'update', kind: 'creator', entityId: loser, fields: { description: 'x' } },
    ]);
    await publish(author, mod, [merge('creator', loser, winner)]);
    expect((await mod.post(`/api/changes/${pending.changes[0]!.id}/approve`)).status).toBe(200);
    const items = (
      (await (await anon.get(`/api/entities/${winner}/history`)).json()) as {
        items: { changeId: string; op: string; payload?: Record<string, unknown> }[];
      }
    ).items;
    expect(items.some((i) => i.changeId === pending.changes[0]!.id)).toBe(true);
    expect(items.some((i) => i.op === 'create' && i.payload?.name === 'D. Villeneuve')).toBe(true);
  } finally {
    await t.close();
  }
});

it('an update and a relate naming a loser id are accepted and apply to the winner', async () => {
  const { t, author, mod, entity, creditedWorks, twoCreators } = await setup();
  try {
    const { winner, loser } = await twoCreators();
    await publish(author, mod, [merge('creator', loser, winner)]);
    await publish(author, mod, [{ op: 'update', kind: 'creator', entityId: loser, fields: { description: 'y' } }]);
    expect((await entity(winner)).fields.description).toBe('y');
    const w = await publish(author, mod, [film('Enemy'), directed({ ref: 'w' }, { id: loser })]);
    const enemy = w.changes[0]!.entityId!;
    expect(await creditedWorks(winner)).toContain(enemy);
    // A merge naming the loser as `from` resolves to the winner: merging it into the winner is a self-merge.
    const res = await author.post('/api/submissions', { cc0: true, changes: [merge('creator', loser, winner)] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('self_merge');
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
  const { t, author, mod, get, creditIds, twoCreators } = await setup();
  try {
    const { winner, loser, sicario } = await twoCreators();
    const third = await publish(author, mod, [creator('Denis V.')]);
    const stray = third.changes[0]!.entityId!;
    const first = await publish(author, mod, [merge('creator', loser, winner)]);
    // `into` is now merged away: it resolves to the winner.
    const merged = await publish(author, mod, [merge('creator', stray, loser)]);
    expect((await get(stray)).headers.get('location')).toBe(`/api/entities/${winner}`);

    // A later unrelate of a moved relation makes the first merge irreversible.
    const [relationId] = await creditIds(winner, [sicario]);
    await publish(author, mod, [{ op: 'unrelate', relationId }]);
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

/** The entity's field sources, read from the table (the API doesn't serve them). */
async function sourcesOf(t: Awaited<ReturnType<typeof setupTest>>, id: string) {
  const [row] = await t.db.select({ s: entities.fieldSources }).from(entities).where(eq(entities.id, id));
  return row?.s;
}

/** Publishes one creator and returns its entity id and the id of the change that created it. */
async function oneCreator(
  author: Parameters<typeof publish>[0],
  mod: Parameters<typeof publish>[1],
  ...args: Parameters<typeof creator>
) {
  const created = await publish(author, mod, [creator(...args)]);
  return { id: created.changes[0]!.entityId!, changeId: created.changes[0]!.id };
}

it('merging a creator unions names', async () => {
  const { t, author, mod, anon, entity } = await setup();
  try {
    const clemens = await oneCreator(author, mod, 'Samuel Clemens');
    const twain = await oneCreator(author, mod, 'Mark Twain', 'c', { alternateNames: ['Twain'] });
    const merged = await publish(author, mod, [merge('creator', twain.id, clemens.id)]);
    expect((await entity(clemens.id)).fields.alternateNames).toEqual(['Mark Twain', 'Twain']);
    expect((await sourcesOf(t, clemens.id))?.alternateNames).toBe(merged.changes[0]!.id);
    const res = await anon.get('/api/search?q=mark+twain');
    expect(((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([clemens.id]);
  } finally {
    await t.close();
  }
});

it('unmerge restores the winner’s list and source exactly', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    // A winner whose list was set by its create, and one that never had a list.
    const sam = await oneCreator(author, mod, 'Samuel Clemens', 'c', { alternateNames: ['Sam'] });
    const bare = await oneCreator(author, mod, 'S. L. Clemens');
    const twain = await oneCreator(author, mod, 'Mark Twain', 'c', { alternateNames: ['Twain'] });
    const twain2 = await oneCreator(author, mod, 'M. Twain');
    for (const [winner, loser] of [
      [sam, twain],
      [bare, twain2],
    ] as const) {
      const before = await sourcesOf(t, winner.id);
      const merged = await publish(author, mod, [merge('creator', loser.id, winner.id)]);
      expect((await sourcesOf(t, winner.id))?.alternateNames).toBe(merged.changes[0]!.id);
      const res = await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`);
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await entity(winner.id)).fields.alternateNames ?? []).toEqual(winner === sam ? ['Sam'] : []);
      expect(await sourcesOf(t, winner.id)).toEqual(before);
    }
    expect((await sourcesOf(t, sam.id))?.alternateNames).toBe(sam.changeId);
    expect(await sourcesOf(t, bare.id)).not.toHaveProperty('alternateNames');
  } finally {
    await t.close();
  }
});

it('unmerge after a names edit is stale_change', async () => {
  const { t, author, mod } = await setup();
  try {
    const clemens = await oneCreator(author, mod, 'Samuel Clemens');
    const twain = await oneCreator(author, mod, 'Mark Twain');
    const merged = await publish(author, mod, [merge('creator', twain.id, clemens.id)]);
    await publish(author, mod, [
      { op: 'update', kind: 'creator', entityId: clemens.id, fields: { alternateNames: ['Twain'] } },
    ]);
    const res = await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('stale_change');
  } finally {
    await t.close();
  }
});

it('a merge that adds no names leaves the winner’s list and its source alone', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const clemens = await oneCreator(author, mod, 'Samuel Clemens', 'c', { alternateNames: ['Mark Twain'] });
    const twain = await oneCreator(author, mod, 'mark twain', 'c', { alternateNames: ['Samuel Clemens'] });
    const merged = await publish(author, mod, [merge('creator', twain.id, clemens.id)]);
    expect((await entity(clemens.id)).fields.alternateNames).toEqual(['Mark Twain']);
    expect((await sourcesOf(t, clemens.id))?.alternateNames).toBe(clemens.changeId);
    // Its inverse doesn't touch the list, so a later names edit doesn't block reverting it.
    await publish(author, mod, [
      { op: 'update', kind: 'creator', entityId: clemens.id, fields: { alternateNames: ['Twain'] } },
    ]);
    expect((await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`)).status).toBe(200);
    expect((await entity(clemens.id)).fields.alternateNames).toEqual(['Twain']);
  } finally {
    await t.close();
  }
});

it('work merge adds title and original title, deduped', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const work = (title: string, originalTitle: string, alternateTitles: string[]) => ({
      op: 'create',
      kind: 'work',
      ref: 'w',
      fields: { mediaType: 'film_tv', subtype: 'movie', title, originalTitle, alternateTitles },
    });
    const a = await publish(author, mod, [work('Spirited Away', 'Sen to Chihiro no Kamikakushi', ['Chihiro'])]);
    const b = await publish(author, mod, [
      work('Sen to Chihiro no kamikakushi', '千と千尋の神隠し', ['chihiro', 'The Spiriting Away of Sen and Chihiro']),
    ]);
    const winner = a.changes[0]!.entityId!;
    await publish(author, mod, [merge('work', b.changes[0]!.entityId!, winner)]);
    expect((await entity(winner)).fields.alternateTitles).toEqual([
      'Chihiro',
      '千と千尋の神隠し',
      'The Spiriting Away of Sen and Chihiro',
    ]);
  } finally {
    await t.close();
  }
});

it('edit after a large merge', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const names = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix} ${i}`);
    const a = await oneCreator(author, mod, 'Winner', 'c', { alternateNames: names('Alpha') });
    const b = await oneCreator(author, mod, 'Loser', 'c', { alternateNames: names('Beta') });
    await publish(author, mod, [merge('creator', b.id, a.id)]);
    expect((await entity(a.id)).fields.alternateNames).toHaveLength(61);
    const res = await author.post('/api/submissions', {
      cc0: true,
      changes: [{ op: 'update', kind: 'creator', entityId: a.id, fields: { description: 'Many names' } }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const created = (await res.json()) as { changes: { id: string }[] };
    const approved = await mod.post(`/api/changes/${created.changes[0]!.id}/approve`);
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await entity(a.id)).fields.description).toBe('Many names');
  } finally {
    await t.close();
  }
});
