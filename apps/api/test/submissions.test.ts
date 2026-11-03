import { expect, it } from 'vitest';
import { setupTest } from './helpers/setup';

const work = {
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival' },
};
const creator = { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Denis Villeneuve', kind: 'person' } };
const link = { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'director' } };
const submission = (changes: unknown[]) => ({ cc0: true, changes });
const token = (c: string) => c.repeat(40);

type Created = {
  id: string;
  changes: { id: string; seq: number; op: string; status: string; entityId: string | null }[];
};

it('a signed-in user submits a new work with a creator and a work_creator link', async () => {
  const t = await setupTest();
  try {
    const userId = await t.createUser();
    const me = t.as({ kind: 'user', userId });
    const res = await me.post('/api/submissions', submission([work, creator, link]));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.changes.map((c) => [c.seq, c.op, c.status])).toEqual([
      [1, 'create', 'pending'],
      [2, 'create', 'pending'],
      [3, 'relate', 'pending'],
    ]);
    const [w, c, l] = body.changes;
    expect(w?.entityId).toBeTruthy();
    expect(l?.entityId).toBe(w?.entityId);

    const detail = await me.get(`/api/submissions/${body.id}`);
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as { changes: { id: string; dependsOn: string[]; payload: unknown }[] };
    expect(d.changes[2]?.dependsOn.toSorted()).toEqual([w!.id, c!.id].toSorted());
    expect(d.changes[0]?.dependsOn).toEqual([]);
    expect(d.changes[0]?.payload).toMatchObject({ title: 'Arrival', lifecycle: 'unknown' });

    // The reserved work is not an entity until approved. (GET /api/entities/:id arrives with Task 5;
    // for now the route doesn't exist and answers the same 404.)
    const reserved = await t.app.request(`/api/entities/${w!.entityId}`);
    expect(reserved.status).toBe(404);
  } finally {
    await t.close();
  }
});

it('submission without cc0 is 400', async () => {
  const t = await setupTest();
  try {
    const userId = await t.createUser();
    const me = t.as({ kind: 'user', userId });
    expect((await me.post('/api/submissions', { changes: [work] })).status).toBe(400);
    expect((await me.post('/api/submissions', { cc0: false, changes: [work] })).status).toBe(400);
  } finally {
    await t.close();
  }
});

it('anonymous submission without x-amdb-anon is 400 identity_required', async () => {
  const t = await setupTest();
  try {
    const res = await t.as({ kind: 'none' }).post('/api/submissions', submission([work]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'identity_required' } });
  } finally {
    await t.close();
  }
});

it('an anonymous author sees their submission; another anon token and another user get 404; a moderator sees it', async () => {
  const t = await setupTest();
  try {
    const author = t.as({ kind: 'anon', token: token('a') });
    const res = await author.post('/api/submissions', submission([work]));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as Created;

    const mine = await author.get(`/api/submissions/${id}`);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).not.toMatch(/anon_?hash/i);

    expect((await t.as({ kind: 'anon', token: token('b') }).get(`/api/submissions/${id}`)).status).toBe(404);
    const otherUser = await t.createUser();
    expect((await t.as({ kind: 'user', userId: otherUser }).get(`/api/submissions/${id}`)).status).toBe(404);
    expect((await t.as({ kind: 'none' }).get(`/api/submissions/${id}`)).status).toBe(404);
    const mod = await t.createUser({ role: 'moderator' });
    expect((await t.as({ kind: 'user', userId: mod }).get(`/api/submissions/${id}`)).status).toBe(200);

    const list = await author.get('/api/me/submissions');
    expect(((await list.json()) as { items: { id: string }[] }).items.map((s) => s.id)).toEqual([id]);
    const others = await t.as({ kind: 'anon', token: token('b') }).get('/api/me/submissions');
    expect(((await others.json()) as { items: unknown[] }).items).toEqual([]);
  } finally {
    await t.close();
  }
});

it('a session wins over the anonymous header', async () => {
  const t = await setupTest();
  try {
    const userId = await t.createUser();
    const res = await t.app.request('/api/submissions', {
      method: 'POST',
      headers: { 'x-test-user': userId, 'x-amdb-anon': token('a'), 'content-type': 'application/json' },
      body: JSON.stringify(submission([work])),
    });
    const { id } = (await res.json()) as Created;
    expect((await t.as({ kind: 'user', userId }).get(`/api/submissions/${id}`)).status).toBe(200);
    expect((await t.as({ kind: 'anon', token: token('a') }).get(`/api/submissions/${id}`)).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('me/submissions lists newest first and pages with a cursor', async () => {
  const t = await setupTest();
  try {
    const me = t.as({ kind: 'anon', token: token('a') });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(((await (await me.post('/api/submissions', submission([work]))).json()) as Created).id);
    const first = (await (await me.get('/api/me/submissions?limit=2')).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items.map((s) => s.id)).toEqual([ids[2], ids[1]]);
    const second = (await (await me.get(`/api/me/submissions?limit=2&cursor=${first.nextCursor}`)).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(second.items.map((s) => s.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  } finally {
    await t.close();
  }
});

it('a book with a director role is 400 invalid_role', async () => {
  const t = await setupTest();
  try {
    const book = { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'book', subtype: null, title: 'Dune' } };
    const res = await t
      .as({ kind: 'anon', token: token('a') })
      .post('/api/submissions', submission([book, creator, link]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_role' } });
  } finally {
    await t.close();
  }
});

it('an unknown ref is 400 unknown_ref', async () => {
  const t = await setupTest();
  try {
    const res = await t.as({ kind: 'anon', token: token('a') }).post('/api/submissions', submission([work, link]));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'unknown_ref' } });
  } finally {
    await t.close();
  }
});

it('invalid fields are 400 invalid_fields; an unknown entity is 400 unknown_entity', async () => {
  const t = await setupTest();
  try {
    const anon = t.as({ kind: 'anon', token: token('a') });
    const bad = await anon.post(
      '/api/submissions',
      submission([{ ...work, fields: { mediaType: 'book', subtype: 'movie', title: 'x' } }]),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'invalid_fields' } });

    const update = { op: 'update', kind: 'work', entityId: crypto.randomUUID(), fields: { title: 'New' } };
    const unknown = await anon.post('/api/submissions', submission([update]));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: 'unknown_entity' } });
  } finally {
    await t.close();
  }
});

it('an update of another visible pending create depends on it; one nobody can see is unknown', async () => {
  const t = await setupTest();
  try {
    const mine = t.as({ kind: 'anon', token: token('a') });
    const first = (await (await mine.post('/api/submissions', submission([work]))).json()) as Created;
    const reserved = first.changes[0]!;
    const update = { op: 'update', kind: 'work', entityId: reserved.entityId, fields: { title: 'Arrival (2016)' } };

    const ok = await mine.post('/api/submissions', submission([update]));
    expect(ok.status).toBe(201);
    const second = (await ok.json()) as Created;
    const detail = (await (await mine.get(`/api/submissions/${second.id}`)).json()) as {
      changes: { dependsOn: string[]; base: unknown }[];
    };
    expect(detail.changes[0]?.dependsOn).toEqual([reserved.id]);

    const stranger = await t.as({ kind: 'anon', token: token('b') }).post('/api/submissions', submission([update]));
    expect(stranger.status).toBe(400);
    expect(await stranger.json()).toMatchObject({ error: { code: 'unknown_entity' } });
  } finally {
    await t.close();
  }
});

it('the 21st anonymous submission in an hour is 429', async () => {
  const t = await setupTest();
  try {
    const anon = t.as({ kind: 'anon', token: token('a') });
    for (let i = 0; i < 20; i++) expect((await anon.post('/api/submissions', submission([work]))).status).toBe(201);
    const res = await anon.post('/api/submissions', submission([work]));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Another visitor, and signed-in users, are unaffected.
    expect((await t.as({ kind: 'anon', token: token('b') }).post('/api/submissions', submission([work]))).status).toBe(
      201,
    );
    const userId = await t.createUser();
    expect((await t.as({ kind: 'user', userId }).post('/api/submissions', submission([work]))).status).toBe(201);
  } finally {
    await t.close();
  }
});

it('anonymous submissions are also limited per client IP', async () => {
  const t = await setupTest();
  try {
    const post = (tok: string) =>
      t.app.request('/api/submissions', {
        method: 'POST',
        headers: { 'x-amdb-anon': tok, 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'content-type': 'application/json' },
        body: JSON.stringify(submission([work])),
      });
    for (let i = 0; i < 20; i++) expect((await post(token(String.fromCharCode(97 + i)))).status).toBe(201);
    expect((await post(token('z'))).status).toBe(429);
  } finally {
    await t.close();
  }
});
