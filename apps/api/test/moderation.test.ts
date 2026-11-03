import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { changes, submissions } from '../src/platform/db/schema';
import { approveAll, publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = {
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival' },
};
const creator = { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis Villeneuve', kind: 'person' } };
const link = { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'director' } };
const token = (c: string) => c.repeat(40);

type QueueItem = {
  change: { id: string; op: string; status: string; submissionId: string };
  submission: { id: string; author: 'anonymous' | { userId: string } };
  ageSeconds: number;
};
type Entity = {
  id: string;
  kind: string;
  fields: Record<string, unknown>;
  relations: { creators?: { relationId: string; creator: { id: string; title: string }; role: string }[] };
};
type Detail = { changes: { id: string; status: string; reason: string | null; payload: Record<string, unknown> }[] };

async function setup() {
  const t = await setupTest();
  const authorId = await t.createUser();
  const modId = await t.createUser({ role: 'moderator' });
  return {
    t,
    authorId,
    modId,
    author: t.as({ kind: 'user', userId: authorId }),
    mod: t.as({ kind: 'user', userId: modId }),
  };
}

it('the queue lists pending changes oldest first with their age; a contributor gets 404', async () => {
  const { t, author, mod } = await setup();
  try {
    const older = await submit(t.as({ kind: 'anon', token: token('a') }), [work]);
    // Backdate the first submission's change so the order and age don't hinge on clock resolution.
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    await t.db.update(changes).set({ createdAt: twoHoursAgo }).where(eq(changes.submissionId, older.id));
    await t.db.update(submissions).set({ createdAt: twoHoursAgo }).where(eq(submissions.id, older.id));
    const newer = await submit(author, [creator]);

    const res = await mod.get('/api/moderation/queue');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: QueueItem[]; nextCursor: string | null };
    expect(body.items.map((i) => i.change.id)).toEqual([older.changes[0]!.id, newer.changes[0]!.id]);
    expect(body.items[0]?.submission.author).toBe('anonymous');
    expect(body.items[1]?.submission).toEqual({ id: newer.id, author: { userId: expect.any(String) } });
    expect(body.items[0]?.ageSeconds).toBeGreaterThanOrEqual(7200);
    expect(body.items[1]?.ageSeconds).toBeLessThan(60);
    expect(JSON.stringify(body)).not.toMatch(/anon_?hash/i);

    expect((await author.get('/api/moderation/queue')).status).toBe(404);
    expect((await t.as({ kind: 'anon', token: token('a') }).get('/api/moderation/queue')).status).toBe(404);
    expect((await t.as({ kind: 'none' }).get('/api/moderation/queue')).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('approving the creates and the link makes GET /api/entities/:workId show the creator with role director', async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await submit(author, [work, creator, link]);
    const workId = created.changes[0]!.entityId!;
    const creatorId = created.changes[1]!.entityId!;
    expect((await t.as({ kind: 'none' }).get(`/api/entities/${workId}`)).status).toBe(404);

    await approveAll(mod, created);

    const res = await t.as({ kind: 'none' }).get(`/api/entities/${workId}`);
    expect(res.status).toBe(200);
    const entity = (await res.json()) as Entity;
    expect(entity).toMatchObject({ id: workId, kind: 'work', fields: { title: 'Arrival', mediaType: 'film_tv' } });
    expect(entity.relations.creators).toEqual([
      {
        relationId: expect.any(String),
        role: 'director',
        creator: { id: creatorId, kind: 'creator', title: 'Denis Villeneuve' },
      },
    ]);

    const detail = (await (await author.get(`/api/submissions/${created.id}`)).json()) as Detail;
    expect(detail.changes.map((c) => c.status)).toEqual(['approved', 'approved', 'approved']);
    expect((await mod.post(`/api/changes/${created.changes[0]!.id}/approve`)).status).toBe(409);
  } finally {
    await t.close();
  }
});

it('approving a link before its creates is 409 dependency_pending', async () => {
  const { t, author, mod, modId } = await setup();
  try {
    const created = await submit(author, [work, creator, link]);
    // Only moderators review; to anyone else the change doesn't exist.
    expect((await author.post(`/api/changes/${created.changes[0]!.id}/approve`)).status).toBe(404);
    expect(
      (await t.as({ kind: 'anon', token: token('a') }).post(`/api/changes/${created.changes[0]!.id}/approve`)).status,
    ).toBe(404);
    const res = await mod.post(`/api/changes/${created.changes[2]!.id}/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'dependency_pending' } });

    // Still pending, so it can be approved once its creates are. A bare POST (no body) approves too.
    for (const c of created.changes) {
      const bare = await t.app.request(`/api/changes/${c.id}/approve`, {
        method: 'POST',
        headers: { 'x-test-user': modId },
      });
      expect(bare.status, await bare.clone().text()).toBe(200);
    }
  } finally {
    await t.close();
  }
});

it('rejecting a create rejects its pending link with the dependency reason; the author resubmits both and they can be approved', async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await submit(author, [work, creator, link]);
    const [w, c, l] = created.changes;
    const rejected = await mod.post(`/api/changes/${w!.id}/reject`, { reason: 'Title is misspelled' });
    expect(rejected.status).toBe(200);

    const detail = (await (await author.get(`/api/submissions/${created.id}`)).json()) as Detail;
    expect(detail.changes.map((x) => [x.status, x.reason])).toEqual([
      ['rejected', 'Title is misspelled'],
      ['pending', null],
      ['rejected', `Depends on rejected change ${w!.id}`],
    ]);
    // The rejected work is kept, payload and all.
    expect(detail.changes[0]?.payload).toMatchObject({ title: 'Arrival' });

    // Only the author may resubmit.
    expect((await mod.post(`/api/changes/${w!.id}/resubmit`, { fields: { title: 'Arrival' } })).status).toBe(404);
    expect((await t.as({ kind: 'anon', token: token('z') }).post(`/api/changes/${w!.id}/resubmit`)).status).toBe(404);
    expect((await t.as({ kind: 'none' }).post(`/api/changes/${w!.id}/resubmit`)).status).toBe(404);

    const again = await author.post(`/api/changes/${w!.id}/resubmit`, { fields: { title: 'Arrival (2016)' } });
    expect(again.status).toBe(201);
    const newWork = (await again.json()) as { changes: { id: string; entityId: string; status: string }[] };
    expect(newWork.changes[0]).toMatchObject({ entityId: w!.entityId, status: 'pending' });
    expect((await author.post(`/api/changes/${w!.id}/resubmit`, {})).status).toBe(409);

    const linkAgain = await author.post(`/api/changes/${l!.id}/resubmit`, {});
    expect(linkAgain.status).toBe(201);
    const newLink = (await linkAgain.json()) as { id: string; changes: { id: string }[] };
    const linkDetail = (await (await author.get(`/api/submissions/${newLink.id}`)).json()) as {
      changes: { dependsOn: string[] }[];
    };
    expect(linkDetail.changes[0]?.dependsOn.toSorted()).toEqual([newWork.changes[0]!.id, c!.id].toSorted());

    for (const id of [newWork.changes[0]!.id, c!.id, newLink.changes[0]!.id]) {
      const res = await mod.post(`/api/changes/${id}/approve`);
      expect(res.status, await res.clone().text()).toBe(200);
    }
    const entity = (await (await t.as({ kind: 'none' }).get(`/api/entities/${w!.entityId}`)).json()) as Entity;
    expect(entity.fields.title).toBe('Arrival (2016)');
    expect(entity.relations.creators?.map((x) => x.role)).toEqual(['director']);
  } finally {
    await t.close();
  }
});

it('approving an update whose field changed since submission is 409 stale_change', async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const workId = created.changes[0]!.entityId!;
    const update = (title: string) => ({ op: 'update', kind: 'work', entityId: workId, fields: { title } });
    const first = await submit(author, [update('Arrival (film)')]);
    const second = await submit(t.as({ kind: 'anon', token: token('b') }), [update('Story of Your Life')]);

    expect((await mod.post(`/api/changes/${second.changes[0]!.id}/approve`)).status).toBe(200);
    const res = await mod.post(`/api/changes/${first.changes[0]!.id}/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'stale_change', details: { fields: ['title'] } } });

    const entity = (await (await t.as({ kind: 'none' }).get(`/api/entities/${workId}`)).json()) as Entity;
    expect(entity.fields.title).toBe('Story of Your Life');
  } finally {
    await t.close();
  }
});

it("edit-and-approve stores the moderator's value and keeps the submitted one", async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await submit(author, [{ ...work, fields: { ...work.fields, title: 'Arival' } }]);
    const [w] = created.changes;
    const res = await mod.post(`/api/changes/${w!.id}/approve`, { fields: { title: 'Arrival' } });
    expect(res.status).toBe(200);

    const entity = (await (await t.as({ kind: 'none' }).get(`/api/entities/${w!.entityId}`)).json()) as Entity;
    expect(entity.fields.title).toBe('Arrival');
    const detail = (await (await author.get(`/api/submissions/${created.id}`)).json()) as Detail;
    expect(detail.changes[0]?.payload).toMatchObject({ title: 'Arrival', submitted: { title: 'Arival' } });

    // An edit that breaks the field rules is refused before anything is applied.
    const other = await submit(author, [{ ...creator }]);
    const bad = await mod.post(`/api/changes/${other.changes[0]!.id}/approve`, { fields: { kind: 'robot' } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_fields' } });
  } finally {
    await t.close();
  }
});

it("the rejected change's author sees the reason in GET /api/submissions/:id", async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await submit(author, [creator]);
    const id = created.changes[0]!.id;
    expect((await mod.post(`/api/changes/${id}/reject`, { reason: '' })).status).toBe(400);
    expect((await author.post(`/api/changes/${id}/reject`, { reason: 'mine' })).status).toBe(404);
    expect((await mod.post(`/api/changes/${id}/reject`, { reason: 'Not a real person' })).status).toBe(200);
    expect((await mod.post(`/api/changes/${id}/reject`, { reason: 'again' })).status).toBe(409);

    const detail = (await (await author.get(`/api/submissions/${created.id}`)).json()) as Detail;
    expect(detail.changes[0]).toMatchObject({ status: 'rejected', reason: 'Not a real person' });
  } finally {
    await t.close();
  }
});

it('an update that would leave the work invalid is 409 invalid_fields at approval', async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await publish(author, mod, [work]);
    const workId = created.changes[0]!.entityId!;
    // Valid on its own (month only), but the work has no release year to hang it on.
    const edit = await submit(author, [{ op: 'update', kind: 'work', entityId: workId, fields: { releaseMonth: 5 } }]);
    const res = await mod.post(`/api/changes/${edit.changes[0]!.id}/approve`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_fields' } });
  } finally {
    await t.close();
  }
});

it('edit-and-approve may only change fields the change submitted: anything else is 400 edit_out_of_scope', async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await submit(author, [work]);
    const res = await mod.post(`/api/changes/${created.changes[0]!.id}/approve`, {
      fields: { title: 'Arrival', description: 'Linguist meets heptapods' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'edit_out_of_scope', details: { fields: ['description'] } },
    });
    // Nothing was applied; the change is still pending.
    expect((await t.as({ kind: 'none' }).get(`/api/entities/${created.changes[0]!.entityId}`)).status).toBe(404);
    const detail = (await (await author.get(`/api/submissions/${created.id}`)).json()) as Detail;
    expect(detail.changes[0]?.status).toBe('pending');
  } finally {
    await t.close();
  }
});

it('the queue keeps a submission’s changes in order across pages', async () => {
  const { t, author, mod } = await setup();
  try {
    const created = await submit(author, [work, creator, link]);
    const first = (await (await mod.get('/api/moderation/queue?limit=2')).json()) as {
      items: QueueItem[];
      nextCursor: string | null;
    };
    expect(first.items.map((i) => i.change.id)).toEqual(created.changes.slice(0, 2).map((c) => c.id));
    expect(first.nextCursor).toBeTruthy();
    const second = (await (await mod.get(`/api/moderation/queue?limit=2&cursor=${first.nextCursor}`)).json()) as {
      items: QueueItem[];
      nextCursor: string | null;
    };
    expect(second.items.map((i) => i.change.id)).toEqual([created.changes[2]!.id]);
    expect(second.nextCursor).toBeNull();
    expect((await mod.get('/api/moderation/queue?cursor=nope')).status).toBe(400);
  } finally {
    await t.close();
  }
});

it('an update can clear an optional field, and reverting it restores the value', async () => {
  const t = await setupTest();
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const anon = t.as({ kind: 'none' });
    const made = await publish(author, mod, [
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis', kind: 'person', description: 'Director' } },
    ]);
    const id = made.changes[0]!.entityId!;
    const fields = async () =>
      ((await (await anon.get(`/api/entities/${id}`)).json()) as { fields: Record<string, unknown> }).fields;

    const required = await author.post('/api/submissions', {
      cc0: true,
      changes: [{ op: 'update', kind: 'creator', entityId: id, fields: { name: null } }],
    });
    expect(required.status).toBe(400);

    const cleared = await publish(author, mod, [
      { op: 'update', kind: 'creator', entityId: id, fields: { description: null } },
    ]);
    expect((await fields()).description).toBeNull();
    expect((await mod.post(`/api/changes/${cleared.changes[0]!.id}/revert`)).status).toBe(200);
    expect((await fields()).description).toBe('Director');
  } finally {
    await t.close();
  }
});

it('an update can clear a work’s release date', async () => {
  const t = await setupTest();
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const made = await publish(author, mod, [
      {
        op: 'create',
        kind: 'work',
        ref: 'w',
        fields: {
          mediaType: 'book',
          subtype: null,
          title: 'Dune',
          releaseYear: 1965,
          releaseMonth: 8,
          description: 'x',
        },
      },
    ]);
    const id = made.changes[0]!.entityId!;
    await publish(author, mod, [
      {
        op: 'update',
        kind: 'work',
        entityId: id,
        fields: { releaseYear: null, releaseMonth: null, description: null },
      },
    ]);
    const entity = (await (await t.as({ kind: 'none' }).get(`/api/entities/${id}`)).json()) as {
      fields: Record<string, unknown>;
    };
    expect(entity.fields).toMatchObject({ releaseYear: null, releaseMonth: null, description: null, title: 'Dune' });
  } finally {
    await t.close();
  }
});
