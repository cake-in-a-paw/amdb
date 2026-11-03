import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { works } from '../src/platform/db/schema';
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
type Detail = { changes: { status: string }[] };

async function setup() {
  const t = await setupTest({ reviewPolicy: publishUpdates });
  const modId = await t.createUser({ role: 'moderator' });
  const mod = t.as({ kind: 'user', userId: modId });
  const author = t.as({ kind: 'anon', token: token('a') });
  const created = await publish(author, mod, [work]);
  const workId = created.changes[0]!.entityId!;
  const edit = await submit(author, [
    { op: 'update', kind: 'work', entityId: workId, fields: { title: 'Dune Messiah', description: 'Sequel' } },
  ]);
  const read = async () =>
    ((await (await t.as({ kind: 'none' }).get(`/api/entities/${workId}`)).json()) as Entity).fields;
  return { t, mod, author, workId, edit, read };
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
  const { t, mod, author, workId, edit, read } = await setup();
  try {
    const res = await mod.post(`/api/changes/${edit.changes[0]!.id}/reject`, { reason: 'Wrong book' });
    expect(res.status).toBe(200);
    expect(await read()).toMatchObject({ title: 'Dune', description: 'Desert planet' });
    const [row] = await t.db.select({ titleNorm: works.titleNorm }).from(works).where(eq(works.entityId, workId));
    expect(row?.titleNorm).toBe('dune');
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
