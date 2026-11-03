import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { works } from '../src/platform/db/schema';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const film = (title: string) => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title },
});
const creator = (name: string) => ({ op: 'create', kind: 'creator', ref: 'c', fields: { name, kind: 'person' } });

type Err = { error: { code: string } };
const code = async (res: Response) => ((await res.json()) as Err).error.code;

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin' }) });
  const anon = t.as({ kind: 'none' });
  const redact = (who: typeof admin, changeId: string, body: unknown) =>
    who.post(`/api/admin/changes/${changeId}/redact`, body);
  return { t, author, mod, admin, anon, redact };
}

it('a redacted change shows in history as redacted with its reason and no payload', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Arrival')]);
    const id = made.changes[0]!.entityId!;
    const first = await publish(author, mod, [
      { op: 'update', kind: 'work', entityId: id, fields: { description: 'secret' } },
    ]);
    await publish(author, mod, [{ op: 'update', kind: 'work', entityId: id, fields: { description: 'fine' } }]);

    const res = await redact(admin, first.changes[0]!.id, { reason: 'Contains personal data' });
    expect(res.status, await res.clone().text()).toBe(200);

    const hist = (await (await anon.get(`/api/entities/${id}/history`)).json()) as { items: Record<string, unknown>[] };
    const stub = hist.items.find((i) => i.changeId === first.changes[0]!.id);
    expect(stub).toEqual({
      changeId: first.changes[0]!.id,
      op: 'update',
      redacted: true,
      reason: 'Contains personal data',
      author: { userId: expect.any(String) },
      appliedAt: expect.any(String),
    });
    expect(JSON.stringify(hist)).not.toContain('secret');

    // The author and moderators see a null payload, not a 500; the change can't be reverted or redacted twice.
    const sub = (await (await author.get(`/api/submissions/${first.id}`)).json()) as {
      changes: { payload: unknown; base: unknown; redacted: boolean; redactionReason: string }[];
    };
    expect(sub.changes[0]).toMatchObject({
      payload: null,
      base: null,
      redacted: true,
      redactionReason: 'Contains personal data',
    });
    expect((await (await author.get('/api/me/submissions')).json()) as unknown).toBeTruthy();
    expect((await mod.get('/api/moderation/queue')).status).toBe(200);
    const revert = await mod.post(`/api/changes/${first.changes[0]!.id}/revert`);
    expect(revert.status).toBe(409);
    expect(await code(revert)).toBe('redacted');
    const again = await redact(admin, first.changes[0]!.id, { reason: 'again' });
    expect(again.status).toBe(409);
    expect(await code(again)).toBe('already_redacted');
  } finally {
    await t.close();
  }
});

it('redacting a current value without removeEntity is 409', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Arrival')]);
    const id = made.changes[0]!.entityId!;
    const upd = await publish(author, mod, [
      { op: 'update', kind: 'work', entityId: id, fields: { description: 'secret' } },
    ]);

    for (const changeId of [upd.changes[0]!.id, made.changes[0]!.id]) {
      const res = await redact(admin, changeId, { reason: 'Legal' });
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('content_is_current');
    }
    expect((await anon.get(`/api/entities/${id}`)).status).toBe(200);
    // Nothing was erased by the refusals.
    const sub = (await (await author.get(`/api/submissions/${upd.id}`)).json()) as { changes: { payload: unknown }[] };
    expect(sub.changes[0]!.payload).not.toBeNull();
  } finally {
    await t.close();
  }
});

it('a removed entity answers 410 and leaves search and duplicates', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Zyxwvut Rising')]);
    const id = made.changes[0]!.entityId!;
    const found = async () =>
      ((await (await anon.get('/api/search?q=zyxwvut')).json()) as { items: unknown[] }).items.length;
    expect(await found()).toBe(1);

    const res = await redact(admin, made.changes[0]!.id, { reason: 'Defamatory', removeEntity: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ id: made.changes[0]!.id, entityId: id, relationId: null });

    const got = await anon.get(`/api/entities/${id}`);
    expect(got.status).toBe(410);
    expect(await code(got)).toBe('removed');
    expect((await anon.get(`/api/entities/${id}/history`)).status).toBe(410);
    expect(await found()).toBe(0);
    const dup = (await (await anon.get('/api/duplicates?kind=work&title=Zyxwvut%20Rising')).json()) as {
      existing: unknown[];
    };
    expect(dup.existing).toHaveLength(0);
    // New changes against it are refused.
    const upd = await author.post('/api/submissions', {
      cc0: true,
      changes: [{ op: 'update', kind: 'work', entityId: id, fields: { description: 'x' } }],
    });
    expect(upd.status).toBe(400);
    expect(await code(upd)).toBe('unknown_entity');
  } finally {
    await t.close();
  }
});

it('redacting a current relate with removeEntity removes the relation, not its ends', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const made = await publish(author, mod, [
      film('Arrival'),
      creator('Denis'),
      {
        op: 'relate',
        type: 'work_creator',
        from: { ref: 'w' },
        to: { ref: 'c' },
        data: { role: 'director' },
      },
    ]);
    const work = made.changes[0]!.entityId!;
    const relate = made.changes[2]!.id;
    const bare = await redact(admin, relate, { reason: 'Wrong' });
    expect(await code(bare)).toBe('content_is_current');
    const res = await redact(admin, relate, { reason: 'Wrong', removeEntity: true });
    expect(res.status, await res.clone().text()).toBe(200);
    const entity = (await (await anon.get(`/api/entities/${work}`)).json()) as { relations: { creators: unknown[] } };
    expect(entity.relations.creators).toHaveLength(0);
  } finally {
    await t.close();
  }
});

it('redacting a pending change rejects it and drops it from the queue', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const pending = await submit(author, [film('Arrival')]);
    const res = await redact(admin, pending.changes[0]!.id, { reason: 'Abuse' });
    expect(res.status, await res.clone().text()).toBe(200);
    const queue = (await (await mod.get('/api/moderation/queue')).json()) as { items: unknown[] };
    expect(queue.items).toHaveLength(0);
    const approve = await mod.post(`/api/changes/${pending.changes[0]!.id}/approve`);
    expect(approve.status).toBe(409);
    const resubmit = await author.post(`/api/changes/${pending.changes[0]!.id}/resubmit`);
    expect(resubmit.status).toBe(409);
    expect(await code(resubmit)).toBe('redacted');
  } finally {
    await t.close();
  }
});

it('a moderator calling redact gets 404', async () => {
  const { t, author, mod, anon, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Arrival')]);
    const id = made.changes[0]!.id;
    for (const who of [mod, author, anon]) {
      const res = await redact(who, id, { reason: 'x', removeEntity: true });
      expect(res.status).toBe(404);
    }
    expect((await author.get(`/api/entities/${made.changes[0]!.entityId}`)).status).toBe(200);
  } finally {
    await t.close();
  }
});

it('undoing a merge is a 409 stale_change once a dropped relation’s other end was removed', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const mk = async (name: string) => (await publish(author, mod, [creator(name)])).changes[0]!.entityId!;
    const winner = await mk('Denis Villeneuve');
    const loser = await mk('D. Villeneuve');
    const dune = await publish(author, mod, [film('Dune')]);
    const directed = (c: string) => ({
      op: 'relate',
      type: 'work_creator',
      from: { id: dune.changes[0]!.entityId },
      to: { id: c },
      data: { role: 'director' },
    });
    await publish(author, mod, [directed(winner), directed(loser)]);
    const merged = await publish(author, mod, [{ op: 'merge', kind: 'creator', from: loser, into: winner }]);

    const res = await redact(admin, dune.changes[0]!.id, { reason: 'Legal', removeEntity: true });
    expect(res.status, await res.clone().text()).toBe(200);
    const revert = await mod.post(`/api/changes/${merged.changes[0]!.id}/revert`);
    expect(revert.status).toBe(409);
    expect(await code(revert)).toBe('stale_change');
  } finally {
    await t.close();
  }
});

it('reverting a later update does not bring redacted content back', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Arrival')]);
    const id = made.changes[0]!.entityId!;
    const upd = (d: string) => [{ op: 'update', kind: 'work', entityId: id, fields: { description: d } }];
    const a = await publish(author, mod, upd('secret'));
    const b = await publish(author, mod, upd('fine'));
    expect((await redact(admin, a.changes[0]!.id, { reason: 'Legal' })).status).toBe(200);
    const revert = await mod.post(`/api/changes/${b.changes[0]!.id}/revert`);
    expect(revert.status, await revert.clone().text()).toBe(200);

    const seen = [
      await (await anon.get(`/api/entities/${id}`)).text(),
      await (await mod.get(`/api/submissions/${b.id}`)).text(),
      await (await mod.get(`/api/submissions/${a.id}`)).text(),
      await (await anon.get(`/api/entities/${id}/history`)).text(),
      await (await mod.get('/api/moderation/queue')).text(),
    ];
    for (const body of seen) expect(body).not.toContain('secret');
  } finally {
    await t.close();
  }
});

it('removing an entity erases its text and rejects pending changes against it', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Zyxwvut Rising')]);
    const id = made.changes[0]!.entityId!;
    const pending = await submit(author, [{ op: 'update', kind: 'work', entityId: id, fields: { description: 'x' } }]);
    expect((await redact(admin, made.changes[0]!.id, { reason: 'Legal', removeEntity: true })).status).toBe(200);
    const sub = (await (await author.get(`/api/submissions/${pending.id}`)).json()) as {
      changes: { status: string }[];
    };
    expect(sub.changes[0]!.status).toBe('rejected');
    const [row] = await t.db.select().from(works).where(eq(works.entityId, id));
    expect(row).toMatchObject({ title: '[removed]', description: null });
    expect(JSON.stringify(row)).not.toContain('Zyxwvut');
  } finally {
    await t.close();
  }
});

it('a redacted merge keeps its ids and stays in the winner’s history', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const mk = async (name: string) => (await publish(author, mod, [creator(name)])).changes[0]!.entityId!;
    const winner = await mk('Denis Villeneuve');
    const loser = await mk('D. Villeneuve');
    const merged = await publish(author, mod, [{ op: 'merge', kind: 'creator', from: loser, into: winner }]);
    const res = await redact(admin, merged.changes[0]!.id, { reason: 'Legal', removeEntity: true });
    expect(res.status, await res.clone().text()).toBe(200);
    const hist = (await (await anon.get(`/api/entities/${winner}/history`)).json()) as {
      items: { changeId: string; redacted?: boolean }[];
    };
    expect(hist.items.find((i) => i.changeId === merged.changes[0]!.id)?.redacted).toBe(true);
  } finally {
    await t.close();
  }
});
