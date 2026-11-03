import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { changes, works } from '../src/platform/db/schema';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = {
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival', releaseYear: 2016 },
};
const update = (entityId: string, fields: Record<string, unknown>) => ({
  op: 'update',
  kind: 'work',
  entityId,
  fields,
});

type Item = {
  changeId: string;
  op: string;
  payload?: Record<string, unknown>;
  author?: 'anonymous' | { userId: string };
  source?: string;
  appliedAt?: string;
  revertOf?: string | null;
  redacted?: true;
  reason?: string;
};
type Entity = { fields: Record<string, unknown>; fieldSources: Record<string, string> };

async function setup() {
  const t = await setupTest();
  const authorId = await t.createUser();
  const author = t.as({ kind: 'user', userId: authorId });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  const history = async (id: string) => {
    const res = await anon.get(`/api/entities/${id}/history`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { items: Item[]; nextCursor: string | null };
  };
  const entity = async (id: string) => (await (await anon.get(`/api/entities/${id}`)).json()) as Entity;
  return { t, authorId, author, mod, anon, history, entity };
}

it('history lists approved changes newest first and omits pending and rejected ones', async () => {
  const { t, authorId, author, mod, history } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const id = created.changes[0]!.entityId!;
    const second = await publish(author, mod, [update(id, { title: 'Arrival (2016)' })]);
    await submit(author, [update(id, { title: 'pending title' })]);
    const rejected = await submit(author, [update(id, { title: 'rejected title' })]);
    expect((await mod.post(`/api/changes/${rejected.changes[0]!.id}/reject`, { reason: 'nope' })).status).toBe(200);

    const { items } = await history(id);
    expect(items.map((i) => i.changeId)).toEqual([second.changes[0]!.id, created.changes[0]!.id]);
    expect(items[0]).toEqual({
      changeId: second.changes[0]!.id,
      op: 'update',
      payload: { title: 'Arrival (2016)' },
      author: { userId: authorId },
      source: 'human',
      appliedAt: expect.any(String),
      revertOf: null,
    });
    expect(JSON.stringify(items)).not.toContain('pending title');
    expect(JSON.stringify(items)).not.toContain('rejected title');
  } finally {
    await t.close();
  }
});

it('history shows an anonymous author as "anonymous" and 404s for an unknown or reserved entity', async () => {
  const { t, mod, anon, history } = await setup();
  try {
    const visitor = t.as({ kind: 'anon', token: 'a'.repeat(40) });
    const created = await publish(visitor, mod, [work]);
    expect((await history(created.changes[0]!.entityId!)).items[0]?.author).toBe('anonymous');

    const pending = await submit(visitor, [{ ...work, ref: 'p' }]);
    expect((await anon.get(`/api/entities/${pending.changes[0]!.entityId}/history`)).status).toBe(404);
    expect((await anon.get(`/api/entities/${crypto.randomUUID()}/history`)).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('history includes changes to the entity’s relations, from either end', async () => {
  const { t, author, mod, history } = await setup();
  try {
    const created = await publish(author, mod, [
      work,
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis Villeneuve', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'director' } },
    ]);
    const [w, c, link] = created.changes;
    expect((await history(w!.entityId!)).items.map((i) => i.changeId)).toEqual([link!.id, w!.id]);
    expect((await history(c!.entityId!)).items.map((i) => i.changeId)).toEqual([link!.id, c!.id]);
  } finally {
    await t.close();
  }
});

it('history shows a redacted change as a stub with its reason', async () => {
  const { t, author, mod, history } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const id = created.changes[0]!.entityId!;
    const upd = await publish(author, mod, [update(id, { title: 'Bad' })]);
    await t.db
      .update(changes)
      .set({ payload: null, inverse: null, redactedAt: new Date(), redactionReason: 'abuse' })
      .where(eq(changes.id, upd.changes[0]!.id));
    expect((await history(id)).items[0]).toEqual({
      changeId: upd.changes[0]!.id,
      op: 'update',
      redacted: true,
      reason: 'abuse',
    });
  } finally {
    await t.close();
  }
});

it('fieldSources points title at the change that last set it', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const id = created.changes[0]!.entityId!;
    const upd = await publish(author, mod, [update(id, { title: 'Arrival (2016)' })]);
    const sources = (await entity(id)).fieldSources;
    expect(sources.title).toBe(upd.changes[0]!.id);
    expect(sources.releaseYear).toBe(created.changes[0]!.id);
  } finally {
    await t.close();
  }
});

it('revert restores the previous title and appears in history with revertOf', async () => {
  const { t, author, mod, history, entity } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const id = created.changes[0]!.entityId!;
    const upd = await publish(author, mod, [update(id, { title: 'Vandalism' })]);
    const updId = upd.changes[0]!.id;

    const res = await mod.post(`/api/changes/${updId}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('approved');

    const after = await entity(id);
    expect(after.fields.title).toBe('Arrival');
    expect(after.fieldSources.title).toBe(created.changes[0]!.id);

    const { items } = await history(id);
    expect(items[0]).toMatchObject({ changeId: body.id, revertOf: updId, payload: { revertOf: updId } });
    expect(items.map((i) => i.changeId)).toContain(updId);

    // Twice is a conflict, and a revert itself can't be reverted.
    const again = await mod.post(`/api/changes/${updId}/revert`);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('already_reverted');
    expect((await mod.post(`/api/changes/${body.id}/revert`)).status).toBe(409);
  } finally {
    await t.close();
  }
});

it('reverting an update whose fields changed later is 409 stale_change, a create with later changes is 409 has_dependents, and a lone create reverts', async () => {
  const { t, author, mod, anon } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const id = created.changes[0]!.entityId!;
    const first = await publish(author, mod, [update(id, { title: 'One' })]);
    await publish(author, mod, [update(id, { title: 'Two' })]);

    const blocked = await mod.post(`/api/changes/${first.changes[0]!.id}/revert`);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('stale_change');

    const createBlocked = await mod.post(`/api/changes/${created.changes[0]!.id}/revert`);
    expect(createBlocked.status).toBe(409);
    expect(((await createBlocked.json()) as { error: { code: string } }).error.code).toBe('has_dependents');

    const lone = await publish(author, mod, [{ ...work, ref: 'lone', fields: { ...work.fields, title: 'Lone' } }]);
    const loneId = lone.changes[0]!.entityId!;
    expect((await mod.post(`/api/changes/${lone.changes[0]!.id}/revert`)).status).toBe(200);
    expect((await anon.get(`/api/entities/${loneId}`)).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('revert undoes a relate (removes it) and an unrelate (restores it)', async () => {
  const { t, author, mod, anon } = await setup();
  try {
    const created = await publish(author, mod, [
      work,
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis Villeneuve', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'director' } },
    ]);
    const [w, , link] = created.changes;
    const creators = async () =>
      (
        (await (await anon.get(`/api/entities/${w!.entityId}`)).json()) as {
          relations: { creators: { relationId: string }[] };
        }
      ).relations.creators;
    expect(await creators()).toHaveLength(1);
    const relationId = (await creators())[0]!.relationId;

    const unrelate = await publish(author, mod, [{ op: 'unrelate', relationId }]);
    expect(await creators()).toHaveLength(0);
    expect((await mod.post(`/api/changes/${unrelate.changes[0]!.id}/revert`)).status).toBe(200);
    expect((await creators()).map((c) => c.relationId)).toEqual([relationId]);

    expect((await mod.post(`/api/changes/${link!.id}/revert`)).status).toBe(200);
    expect(await creators()).toHaveLength(0);
  } finally {
    await t.close();
  }
});

it('a contributor calling revert gets 404', async () => {
  const { t, author, mod, anon } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const id = created.changes[0]!.id;
    expect((await author.post(`/api/changes/${id}/revert`)).status).toBe(404);
    expect((await anon.post(`/api/changes/${id}/revert`)).status).toBe(404);
    expect((await mod.post(`/api/changes/${crypto.randomUUID()}/revert`)).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('a pending change can’t be reverted', async () => {
  const { t, author, mod } = await setup();
  try {
    const pending = await submit(author, [work]);
    const res = await mod.post(`/api/changes/${pending.changes[0]!.id}/revert`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_live');
  } finally {
    await t.close();
  }
});

it('reviving a retracted entity resets every column to the new create’s values', async () => {
  // Only the first create goes live; its resubmission (a different title) waits for a moderator.
  const t = await setupTest({
    reviewPolicy: ({ change }) => (change.op === 'create' && change.fields.title === 'Arrival' ? 'publish' : 'hold'),
  });
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'anon', token: 'a'.repeat(40) });
    const first = await submit(author, [
      {
        ...work,
        fields: {
          ...work.fields,
          originalTitle: 'Story of Your Life',
          description: 'Aliens',
          releaseMonth: 11,
          releaseDay: 11,
        },
      },
    ]);
    const [create] = first.changes;
    const id = create!.entityId!;
    expect((await mod.post(`/api/changes/${create!.id}/reject`, { reason: 'dup' })).status).toBe(200);

    // The API can only add to a resubmitted create's fields, so drop the optional ones in the row.
    const again = await author.post(`/api/changes/${create!.id}/resubmit`, { fields: { title: 'Arrival (2016)' } });
    expect(again.status, await again.clone().text()).toBe(201);
    const resubmitted = ((await again.json()) as { changes: { id: string }[] }).changes[0]!.id;
    await t.db
      .update(changes)
      .set({ payload: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival (2016)', lifecycle: 'unknown' } })
      .where(eq(changes.id, resubmitted));
    expect((await mod.post(`/api/changes/${resubmitted}/approve`)).status).toBe(200);

    const [row] = await t.db.select().from(works).where(eq(works.entityId, id));
    expect(row).toMatchObject({
      title: 'Arrival (2016)',
      titleNorm: 'arrival (2016)',
      originalTitle: null,
      description: null,
      releaseYear: null,
      releaseMonth: null,
      releaseDay: null,
      attributes: {},
    });
  } finally {
    await t.close();
  }
});
