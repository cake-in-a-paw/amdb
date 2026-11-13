import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { entities, works } from '../src/platform/db/schema';
import type { ReviewPolicy } from '../src/features/changes/review-policy';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

/** Live, review after — for updates only. */
const publishUpdates: ReviewPolicy = ({ change }) => (change.op === 'update' ? 'publish' : 'hold');

const work = {
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'book', subtype: null, title: 'Dune', description: 'Desert planet' },
};
const token = (c: string) => c.repeat(40);

type Entity = { fields: Record<string, unknown> };
type Detail = { changes: { id: string; status: string; reason: string | null; payload: unknown }[] };

async function setup() {
  const t = await setupTest({ reviewPolicy: publishUpdates });
  const modId = await t.createUser({ role: 'moderator' });
  const mod = t.as({ kind: 'user', userId: modId });
  const author = t.as({ kind: 'anon', token: token('a') });
  const created = await publish(author, mod, [work]);
  const workId = created.changes[0]!.entityId!;
  const sources = async () =>
    (await t.db.select({ s: entities.fieldSources }).from(entities).where(eq(entities.id, workId)))[0]?.s;
  const sourcesBefore = await sources();
  const edit = await submit(author, [
    { op: 'update', kind: 'work', entityId: workId, fields: { title: 'Dune Messiah', description: 'Sequel' } },
  ]);
  const read = async () =>
    ((await (await t.as({ kind: 'none' }).get(`/api/entities/${workId}`)).json()) as Entity).fields;
  return { t, mod, author, workId, edit, read, sources, sourcesBefore };
}

it('a published update is live immediately and in the queue', async () => {
  const { t, mod, edit, read } = await setup();
  try {
    expect(edit.changes[0]?.status).toBe('published');
    expect(await read()).toMatchObject({ title: 'Dune Messiah', description: 'Sequel' });

    const queue = (await (await mod.get('/api/moderation/queue')).json()) as {
      items: { change: { id: string; status: string } }[];
    };
    expect(queue.items.map((i) => [i.change.id, i.change.status])).toEqual([[edit.changes[0]!.id, 'published']]);
  } finally {
    await t.close();
  }
});

it('rejecting it restores the previous value', async () => {
  const { t, mod, author, workId, edit, read, sources, sourcesBefore } = await setup();
  try {
    const res = await mod.post(`/api/changes/${edit.changes[0]!.id}/reject`, { reason: 'Wrong book' });
    expect(res.status).toBe(200);
    expect(await read()).toMatchObject({ title: 'Dune', description: 'Desert planet' });
    const [row] = await t.db.select({ titleNorm: works.titleNorm }).from(works).where(eq(works.entityId, workId));
    expect(row?.titleNorm).toBe('dune');
    // field_sources is back exactly as it was: title and description point at the create again.
    expect(sourcesBefore?.title).toBeTruthy();
    expect(await sources()).not.toEqual({});
    expect(await sources()).toStrictEqual(sourcesBefore);
    const detail = (await (await author.get(`/api/submissions/${edit.id}`)).json()) as Detail;
    expect(detail.changes[0]?.status).toBe('rejected');
  } finally {
    await t.close();
  }
});

it('approving it changes only status', async () => {
  const { t, mod, author, edit, read } = await setup();
  try {
    const before = await read();
    const res = await mod.post(`/api/changes/${edit.changes[0]!.id}/approve`);
    expect(res.status).toBe(200);
    expect(await read()).toEqual(before);
    const detail = (await (await author.get(`/api/submissions/${edit.id}`)).json()) as Detail;
    expect(detail.changes[0]?.status).toBe('approved');
    const queue = (await (await mod.get('/api/moderation/queue')).json()) as { items: unknown[] };
    expect(queue.items).toEqual([]);
  } finally {
    await t.close();
  }
});

it('a published create that a live link builds on is 409 has_dependents to reject', async () => {
  const t = await setupTest({ reviewPolicy: () => 'publish' });
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'anon', token: token('a') });
    const created = await submit(author, [
      work,
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Frank Herbert', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'author' } },
    ]);
    expect(created.changes.map((c) => c.status)).toEqual(['published', 'published', 'published']);
    const res = await mod.post(`/api/changes/${created.changes[0]!.id}/reject`, { reason: 'Duplicate' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'has_dependents' } });

    // Rejecting the link first undoes it; the entity stays readable without the creator.
    expect((await mod.post(`/api/changes/${created.changes[2]!.id}/reject`, { reason: 'Wrong' })).status).toBe(200);
    const entity = (await (
      await t.as({ kind: 'none' }).get(`/api/entities/${created.changes[0]!.entityId}`)
    ).json()) as {
      relations: { creators: unknown[] };
    };
    expect(entity.relations.creators).toEqual([]);
  } finally {
    await t.close();
  }
});

it('rejecting the link and then the create retracts the entity; both changes keep their payloads', async () => {
  const t = await setupTest({ reviewPolicy: () => 'publish' });
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'anon', token: token('a') });
    const created = await submit(author, [
      work,
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Frank Herbert', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'author' } },
    ]);
    const [w, c, l] = created.changes;
    expect((await mod.post(`/api/changes/${l!.id}/reject`, { reason: 'Wrong' })).status).toBe(200);
    const res = await mod.post(`/api/changes/${w!.id}/reject`, { reason: 'Duplicate' });
    expect(res.status, await res.clone().text()).toBe(200);

    expect((await t.as({ kind: 'none' }).get(`/api/entities/${w!.entityId}`)).status).toBe(404);
    const creator = (await (await t.as({ kind: 'none' }).get(`/api/entities/${c!.entityId}`)).json()) as {
      relations: { credits: unknown[] };
    };
    expect(creator.relations.credits).toEqual([]);

    const detail = (await (await author.get(`/api/submissions/${created.id}`)).json()) as Detail;
    expect(detail.changes.map((x) => [x.id, x.status, x.reason])).toEqual([
      [w!.id, 'rejected', 'Duplicate'],
      [c!.id, 'published', null],
      [l!.id, 'rejected', 'Wrong'],
    ]);
    expect(detail.changes[0]?.payload).toMatchObject({ title: 'Dune' });
    expect(detail.changes[2]?.payload).toMatchObject({ type: 'work_creator', data: { role: 'author' } });

    // The tombstone keeps the reserved id: resubmitting the create brings the entity back.
    const again = await author.post(`/api/changes/${w!.id}/resubmit`, { cc0: true, fields: { title: 'Dune (1965)' } });
    expect(again.status, await again.clone().text()).toBe(201);
    const back = await t.as({ kind: 'none' }).get(`/api/entities/${w!.entityId}`);
    expect(back.status).toBe(200);
    expect(((await back.json()) as Entity).fields.title).toBe('Dune (1965)');
  } finally {
    await t.close();
  }
});

it('a change the policy would publish is held while what it depends on is pending', async () => {
  const t = await setupTest({ reviewPolicy: publishUpdates });
  try {
    const author = t.as({ kind: 'anon', token: token('a') });
    const created = await submit(author, [work]);
    expect(created.changes[0]?.status).toBe('pending');
    const edit = await submit(author, [
      { op: 'update', kind: 'work', entityId: created.changes[0]!.entityId, fields: { title: 'Dune Messiah' } },
    ]);
    expect(edit.changes[0]?.status).toBe('pending');
  } finally {
    await t.close();
  }
});

it('rejecting a published create also rejects pending changes made against it once it was live', async () => {
  const t = await setupTest({ reviewPolicy: ({ change }) => (change.op === 'create' ? 'publish' : 'hold') });
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const author = t.as({ kind: 'anon', token: token('a') });
    const created = await submit(author, [work]);
    expect(created.changes[0]?.status).toBe('published');
    const workId = created.changes[0]!.entityId!;
    // Submitted after the work went live, so neither change lists the create in depends_on.
    const later = await submit(author, [
      { op: 'update', kind: 'work', entityId: workId, fields: { title: 'Dune Messiah' } },
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Frank Herbert', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { id: workId }, to: { ref: 'c' }, data: { role: 'author' } },
    ]);
    expect((await mod.post(`/api/changes/${created.changes[0]!.id}/reject`, { reason: 'Spam' })).status).toBe(200);

    const detail = (await (await author.get(`/api/submissions/${later.id}`)).json()) as Detail;
    const because = `Depends on rejected change ${created.changes[0]!.id}`;
    expect(detail.changes.map((x) => [x.status, x.reason])).toEqual([
      ['rejected', because],
      ['published', null],
      ['rejected', because],
    ]);
  } finally {
    await t.close();
  }
});

it('under a publish policy, a change that conflicts when applied is held and the rest still publish', async () => {
  const t = await setupTest({ reviewPolicy: () => 'publish' });
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const tag = (ref: string) => ({
      op: 'create',
      kind: 'tag',
      ref,
      fields: { kind: 'genre', name: 'Drama', slug: 'drama' },
    });
    // Both tags are checked before either exists, so the duplicate only shows when it is applied.
    const second = await submit(author, [
      tag('a'),
      tag('b'),
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Keep me', kind: 'person' } },
    ]);
    expect(second.changes.map((c) => c.status)).toEqual(['published', 'pending', 'published']);
    const detail = (await (await author.get(`/api/submissions/${second.id}`)).json()) as Detail;
    expect(detail.changes.map((c) => c.status)).toEqual(['published', 'pending', 'published']);
    expect((await t.as({ kind: 'none' }).get(`/api/entities/${second.changes[2]!.entityId}`)).status).toBe(200);
  } finally {
    await t.close();
  }
});

it('under a publish policy, an update that would leave the work invalid is held, not lost', async () => {
  const t = await setupTest({ reviewPolicy: () => 'publish' });
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const made = await submit(author, [{ ...work, fields: { ...work.fields, releaseYear: 2020, releaseMonth: 2 } }]);
    const id = made.changes[0]!.entityId!;
    const upd = await submit(author, [{ op: 'update', kind: 'work', entityId: id, fields: { releaseDay: 30 } }]);
    expect(upd.changes[0]!.status).toBe('pending');
    const approve = await mod.post(`/api/changes/${upd.changes[0]!.id}/approve`);
    expect(approve.status).toBe(409);
    expect(await approve.json()).toMatchObject({ error: { code: 'invalid_fields' } });
  } finally {
    await t.close();
  }
});
