import { expect, it } from 'vitest';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const film = (ref: string, title: string, extra: Record<string, unknown> = {}) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype: 'movie', title, ...extra },
});
const series = { op: 'create', kind: 'series', ref: 'se', fields: { title: 'Saga' } };

it('me/submissions with no identity is an empty list, not an error', async () => {
  const t = await setupTest();
  try {
    const res = await t.as({ kind: 'none' }).get('/api/me/submissions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], nextCursor: null });
  } finally {
    await t.close();
  }
});

it('a change is readable by its author and moderators, and 404 to anyone else', async () => {
  const t = await setupTest();
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const created = await submit(author, [film('w', 'Arrival')]);
    const id = created.changes[0]!.id;

    const mine = await author.get(`/api/changes/${id}`);
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({
      id,
      submissionId: created.id,
      op: 'create',
      status: 'pending',
      payload: { title: 'Arrival' },
    });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    expect((await mod.get(`/api/changes/${id}`)).status).toBe(200);
    expect((await t.as({ kind: 'user', userId: await t.createUser() }).get(`/api/changes/${id}`)).status).toBe(404);
    expect((await t.as({ kind: 'anon', token: 'a'.repeat(40) }).get(`/api/changes/${id}`)).status).toBe(404);
    expect((await t.as({ kind: 'none' }).get(`/api/changes/${id}`)).status).toBe(404);
    expect((await author.get(`/api/changes/${crypto.randomUUID()}`)).status).toBe(404);
  } finally {
    await t.close();
  }
});

it("counts the caller's pending edits to an entry, including series links recorded on the series", async () => {
  const t = await setupTest();
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const live = await publish(mod, mod, [film('w', 'Dune'), series]);
    const workId = live.changes[0]!.entityId!;
    const seriesId = live.changes[1]!.entityId!;
    const count = async (who: typeof author, id: string) =>
      ((await (await who.get(`/api/me/pending?entityId=${id}`)).json()) as { count: number }).count;

    expect(await count(author, workId)).toBe(0);
    // An update of the work, and a series link whose `from` end is the series.
    await submit(author, [{ op: 'update', kind: 'work', entityId: workId, fields: { title: 'Dune: Part One' } }]);
    await submit(author, [
      { op: 'relate', type: 'series_work', from: { id: seriesId }, to: { id: workId }, data: { position: 1 } },
    ]);
    expect(await count(author, workId)).toBe(2);
    expect(await count(author, seriesId)).toBe(1);
    // Someone else's edits, and a new entry's create, aren't the caller's pending edits.
    expect(await count(mod, workId)).toBe(0);
    const fresh = await submit(author, [film('n', 'New')]);
    expect(await count(author, fresh.changes[0]!.entityId!)).toBe(0);
    expect(await count(t.as({ kind: 'none' }), workId)).toBe(0);
  } finally {
    await t.close();
  }
});

it('a pending unrelate of a series link counts for the work at its `to` end', async () => {
  const t = await setupTest();
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const live = await publish(mod, mod, [
      film('w', 'Dune'),
      series,
      { op: 'relate', type: 'series_work', from: { ref: 'se' }, to: { ref: 'w' }, data: { position: 1 } },
    ]);
    const workId = live.changes[0]!.entityId!;
    const relationId = (
      (await (await t.as({ kind: 'none' }).get(`/api/entities/${workId}`)).json()) as {
        relations: { series: { relationId: string }[] };
      }
    ).relations.series[0]!.relationId;

    await submit(author, [{ op: 'unrelate', relationId }]);

    const res = await author.get(`/api/me/pending?entityId=${workId}`);
    expect(await res.json()).toEqual({ count: 1 });
  } finally {
    await t.close();
  }
});

it('resubmitting a create can clear an optional field with null', async () => {
  const t = await setupTest();
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const created = await submit(author, [film('w', 'Arrival', { originalTitle: 'Story of Your Life' })]);
    const id = created.changes[0]!.id;
    expect((await mod.post(`/api/changes/${id}/reject`, { reason: 'Wrong original title' })).status).toBe(200);

    const res = await author.post(`/api/changes/${id}/resubmit`, { cc0: true, fields: { originalTitle: null } });
    expect(res.status, await res.clone().text()).toBe(201);
    const again = (await res.json()) as { changes: { id: string }[] };
    const change = (await (await author.get(`/api/changes/${again.changes[0]!.id}`)).json()) as {
      payload: Record<string, unknown>;
    };
    expect(change.payload.title).toBe('Arrival');
    expect(change.payload).not.toHaveProperty('originalTitle');
  } finally {
    await t.close();
  }
});
