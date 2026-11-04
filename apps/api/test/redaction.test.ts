import { eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { changes, creators, relations, works } from '../src/platform/db/schema';
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
      author: { userId: expect.any(String), handle: null },
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

it('a rejected update that was based on redacted content no longer shows it', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Arrival')]);
    const id = made.changes[0]!.entityId!;
    const upd = (d: string) => [{ op: 'update', kind: 'work', entityId: id, fields: { description: d } }];
    const a = await publish(author, mod, upd('secret'));
    const b = await submit(author, upd('other'));
    expect((await mod.post(`/api/changes/${b.changes[0]!.id}/reject`, { reason: 'no' })).status).toBe(200);
    const before = await (await author.get(`/api/submissions/${b.id}`)).text();
    expect(before).toContain('secret');

    // A's value is overwritten, so it is no longer current.
    await publish(author, mod, upd('fine'));
    expect((await redact(admin, a.changes[0]!.id, { reason: 'Legal' })).status).toBe(200);
    for (const who of [author, mod]) {
      expect(await (await who.get(`/api/submissions/${b.id}`)).text()).not.toContain('secret');
    }
  } finally {
    await t.close();
  }
});

it('redacting a relate makes an unrelate of it unrevertable', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const made = await publish(author, mod, [
      film('Arrival'),
      creator('Denis'),
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'director' } },
    ]);
    const relationId = (
      (await (await mod.get(`/api/submissions/${made.id}`)).json()) as {
        changes: { op: string; relationId: string }[];
      }
    ).changes.find((c) => c.op === 'relate')!.relationId;
    const un = await publish(author, mod, [{ op: 'unrelate', relationId }]);

    // The relate is no longer current (the unrelate removed it), so no flag is needed.
    const res = await redact(admin, made.changes[2]!.id, { reason: 'Legal' });
    expect(res.status, await res.clone().text()).toBe(200);
    const revert = await mod.post(`/api/changes/${un.changes[0]!.id}/revert`);
    expect(revert.status).toBe(409);
    expect(await code(revert)).toBe('redacted');
  } finally {
    await t.close();
  }
});

/** Two creators, an update to the loser held pending, the merge applied, then the update approved: it lands on the winner. */
async function updateThroughMergedId(s: Awaited<ReturnType<typeof setup>>) {
  const { author, mod } = s;
  const mk = async (name: string) => (await publish(author, mod, [creator(name)])).changes[0]!.entityId!;
  const winner = await mk('Alpha');
  const loser = await mk('Alpha (dup)');
  const upd = await submit(author, [
    { op: 'update', kind: 'creator', entityId: loser, fields: { description: 'SECRET' } },
  ]);
  await publish(author, mod, [{ op: 'merge', kind: 'creator', from: loser, into: winner }]);
  const approved = await mod.post(`/api/changes/${upd.changes[0]!.id}/approve`);
  expect(approved.status, await approved.clone().text()).toBe(200);
  return { winner, loser, upd };
}

it('redacting an update applied through a merged id treats the winner’s content as current', async () => {
  const s = await setup();
  const { t, admin, anon, redact } = s;
  try {
    const { winner, upd } = await updateThroughMergedId(s);
    expect(await (await anon.get(`/api/entities/${winner}`)).text()).toContain('SECRET');

    const bare = await redact(admin, upd.changes[0]!.id, { reason: 'Legal' });
    expect(bare.status).toBe(409);
    expect(await bare.json()).toMatchObject({
      error: { code: 'content_is_current', details: { entityId: winner } },
    });
    const res = await redact(admin, upd.changes[0]!.id, { reason: 'Legal', removeEntity: true });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ id: upd.changes[0]!.id, entityId: winner, relationId: null });
    expect((await anon.get(`/api/entities/${winner}`)).status).toBe(410);
    const rows = await t.db.select().from(creators).where(eq(creators.entityId, winner));
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  } finally {
    await t.close();
  }
});

it('redacting an overwritten update applied through a merged id scrubs the winner’s later changes', async () => {
  const s = await setup();
  const { t, author, mod, admin, anon, redact } = s;
  try {
    const { winner, upd } = await updateThroughMergedId(s);
    const fine = await publish(author, mod, [
      { op: 'update', kind: 'creator', entityId: winner, fields: { description: 'fine' } },
    ]);
    const res = await redact(admin, upd.changes[0]!.id, { reason: 'Legal' });
    expect(res.status, await res.clone().text()).toBe(200);
    const revert = await mod.post(`/api/changes/${fine.changes[0]!.id}/revert`);
    expect(revert.status, await revert.clone().text()).toBe(200);

    const seen = [
      await (await anon.get(`/api/entities/${winner}`)).text(),
      await (await anon.get(`/api/entities/${winner}/history`)).text(),
      await (await mod.get(`/api/submissions/${fine.id}`)).text(),
      await (await mod.get(`/api/submissions/${upd.id}`)).text(),
      await (await mod.get('/api/moderation/queue')).text(),
    ];
    for (const body of seen) expect(body).not.toContain('SECRET');
    const all = await t.db.select().from(changes);
    expect(JSON.stringify(all)).not.toContain('SECRET');
  } finally {
    await t.close();
  }
});

it('a pending update based on redacted content still answers stale_change, and shows its base as redacted', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Arrival')]);
    const id = made.changes[0]!.entityId!;
    const upd = (d: string) => [{ op: 'update', kind: 'work', entityId: id, fields: { description: d } }];
    const a = await publish(author, mod, upd('secret'));
    // Submitted while 'secret' was current: its base records it.
    const pending = await submit(author, upd('mine'));
    // An unrelated pending change whose base doesn't hold the redacted value.
    const title = await submit(author, [{ op: 'update', kind: 'work', entityId: id, fields: { title: 'Arrival!' } }]);
    await publish(author, mod, upd('fine'));
    expect((await redact(admin, a.changes[0]!.id, { reason: 'Legal' })).status).toBe(200);

    const body = await (await author.get(`/api/submissions/${pending.id}`)).text();
    expect(body).not.toContain('secret');
    expect(body).not.toContain('$redacted');
    expect((JSON.parse(body) as { changes: unknown[] }).changes[0]).toMatchObject({
      base: {},
      redactedBaseFields: ['description'],
    });
    const queue = await (await mod.get('/api/moderation/queue')).text();
    expect(queue).not.toContain('$redacted');

    // The stale check survives: approving it would overwrite 'fine' without knowing.
    const approve = await mod.post(`/api/changes/${pending.changes[0]!.id}/approve`);
    expect(approve.status).toBe(409);
    expect(await code(approve)).toBe('stale_change');
    // The unrelated one is untouched.
    expect((await mod.post(`/api/changes/${title.changes[0]!.id}/approve`)).status).toBe(200);
  } finally {
    await t.close();
  }
});

it('redacting a create whose entity was reverted erases the entity’s text', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const made = await publish(author, mod, [film('Zyxwvut Rising')]);
    const id = made.changes[0]!.entityId!;
    expect((await mod.post(`/api/changes/${made.changes[0]!.id}/revert`)).status).toBe(200);
    const res = await redact(admin, made.changes[0]!.id, { reason: 'Legal' });
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await t.db.select().from(works).where(eq(works.entityId, id));
    expect(JSON.stringify(row)).not.toContain('Zyxwvut');
  } finally {
    await t.close();
  }
});

it('redacting a rejected create leaves the entity its resubmission made live alone', async () => {
  const { t, author, mod, admin, anon, redact } = await setup();
  try {
    const made = await submit(author, [film('Zyxwvut Rising')]);
    const id = made.changes[0]!.entityId!;
    expect((await mod.post(`/api/changes/${made.changes[0]!.id}/reject`, { reason: 'typo' })).status).toBe(200);
    const again = await author.post(`/api/changes/${made.changes[0]!.id}/resubmit`, { fields: { title: 'Arrival' } });
    expect(again.status, await again.clone().text()).toBe(201);
    const resub = (await again.json()) as { changes: { id: string }[] };
    expect((await mod.post(`/api/changes/${resub.changes[0]!.id}/approve`)).status).toBe(200);

    expect((await redact(admin, made.changes[0]!.id, { reason: 'Legal' })).status).toBe(200);
    const entity = (await (await anon.get(`/api/entities/${id}`)).json()) as { fields: { title: string } };
    expect(entity.fields.title).toBe('Arrival');
  } finally {
    await t.close();
  }
});

it('redacting a relate erases its role and value from the relation row', async () => {
  const { t, author, mod, admin, redact } = await setup();
  try {
    const made = await publish(author, mod, [
      film('Arrival'),
      creator('Denis'),
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'composer' } },
      { op: 'relate', type: 'external_id', from: { ref: 'w' }, data: { scheme: 'wikidata', value: 'Q-SECRET' } },
    ]);
    const detail = (await (await mod.get(`/api/submissions/${made.id}`)).json()) as {
      changes: { id: string; op: string; relationId: string }[];
    };
    const relates = detail.changes.filter((c) => c.op === 'relate');
    // One no longer current (unrelated first), one current (removed with the redaction).
    await publish(author, mod, [{ op: 'unrelate', relationId: relates[0]!.relationId }]);
    expect((await redact(admin, relates[0]!.id, { reason: 'Legal' })).status).toBe(200);
    expect((await redact(admin, relates[1]!.id, { reason: 'Legal', removeEntity: true })).status).toBe(200);
    const rows = await t.db
      .select()
      .from(relations)
      .where(
        inArray(
          relations.id,
          relates.map((r) => r.relationId),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(JSON.stringify(rows)).not.toContain('composer');
  } finally {
    await t.close();
  }
});
