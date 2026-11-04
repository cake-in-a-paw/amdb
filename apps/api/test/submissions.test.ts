import { describe, expect, it } from 'vitest';
import { publish, submit } from './helpers/catalog';
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

    // The reserved work is not an entity until approved (moderation.test.ts shows the same id at 200 after).
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

/** An anonymous submission with its own `x-forwarded-for` (omitted when null). */
const anonPost = (t: Awaited<ReturnType<typeof setupTest>>, tok: string, xff: string | null) =>
  t.app.request('/api/submissions', {
    method: 'POST',
    headers: {
      'x-amdb-anon': tok,
      'content-type': 'application/json',
      ...(xff === null ? {} : { 'x-forwarded-for': xff }),
    },
    body: JSON.stringify(submission([work])),
  });

async function expectLimited(res: Response) {
  expect(res.status).toBe(429);
  expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });
  const retryAfter = Number(res.headers.get('retry-after'));
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(3600);
}

it('the 21st anonymous submission in an hour from one client is 429 with Retry-After', async () => {
  const t = await setupTest();
  try {
    for (let i = 0; i < 20; i++) expect((await anonPost(t, token('a'), '198.51.100.1')).status).toBe(201);
    await expectLimited(await anonPost(t, token('a'), '198.51.100.1'));
    // Another client, and signed-in users, are unaffected. (A visitor is told apart by address:
    // anonymous tokens are free, so a fresh token is no new visitor.)
    expect((await anonPost(t, token('b'), '198.51.100.2')).status).toBe(201);
    const userId = await t.createUser();
    expect((await t.as({ kind: 'user', userId }).post('/api/submissions', submission([work]))).status).toBe(201);
  } finally {
    await t.close();
  }
});

it('one anonymous token is limited across addresses too', async () => {
  const t = await setupTest();
  try {
    for (let i = 0; i < 20; i++) expect((await anonPost(t, token('a'), `198.51.100.${i}`)).status).toBe(201);
    await expectLimited(await anonPost(t, token('a'), '198.51.100.99'));
  } finally {
    await t.close();
  }
});

it('a fresh anonymous token per request doesn’t escape the limit', async () => {
  const t = await setupTest();
  try {
    for (let i = 0; i < 20; i++)
      expect((await anonPost(t, token(String.fromCharCode(97 + i)), '198.51.100.1')).status).toBe(201);
    await expectLimited(await anonPost(t, token('z'), '198.51.100.1'));
  } finally {
    await t.close();
  }
});

it('the limit keys on the address the trusted proxy appended, not on entries the client sent', async () => {
  const t = await setupTest();
  try {
    // Behind one appending proxy, everything left of the last entry is client-controlled.
    for (let i = 0; i < 20; i++) expect((await anonPost(t, token('a'), `10.0.0.${i}, 203.0.113.9`)).status).toBe(201);
    await expectLimited(await anonPost(t, token('b'), '10.0.0.99, 203.0.113.9'));
    expect((await anonPost(t, token('c'), '10.0.0.1, 203.0.113.10')).status).toBe(201);
  } finally {
    await t.close();
  }
});

it('with two trusted proxy hops, the second entry from the right is the client', async () => {
  const t = await setupTest({ trustedProxyHops: 2 });
  try {
    for (let i = 0; i < 20; i++) {
      expect(
        (await anonPost(t, token(String.fromCharCode(97 + i)), `10.0.0.${i}, 203.0.113.9, 192.0.2.${i}`)).status,
      ).toBe(201);
    }
    await expectLimited(await anonPost(t, token('z'), '10.0.0.99, 203.0.113.9, 192.0.2.99'));
    expect((await anonPost(t, token('y'), '203.0.113.10, 192.0.2.1')).status).toBe(201);
  } finally {
    await t.close();
  }
});

it('anonymous submissions without a forwarded address share one bucket', async () => {
  const t = await setupTest();
  try {
    for (let i = 0; i < 20; i++) expect((await anonPost(t, token(String.fromCharCode(97 + i)), null)).status).toBe(201);
    await expectLimited(await anonPost(t, token('z'), null));
    // Fewer entries than trusted hops can't be trusted either.
    await expectLimited(await anonPost(t, token('y'), ''));
  } finally {
    await t.close();
  }
});

it('CORS lets the web app send the anonymous token and read Retry-After and Location', async () => {
  const t = await setupTest({ webOrigin: 'https://web.example' });
  try {
    const res = await t.app.request('/api/submissions', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://web.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-amdb-anon',
      },
    });
    expect(res.status).toBe(204);
    expect(
      res.headers
        .get('access-control-allow-headers')
        ?.split(',')
        .map((h) => h.trim().toLowerCase()),
    ).toEqual(expect.arrayContaining(['content-type', 'x-amdb-anon']));
    const get = await t.app.request('/api/health', { headers: { Origin: 'https://web.example' } });
    expect(
      get.headers
        .get('access-control-expose-headers')
        ?.split(',')
        .map((h) => h.trim()),
    ).toEqual(expect.arrayContaining(['Retry-After', 'Location']));
  } finally {
    await t.close();
  }
});

it('anonymous resubmits draw on the same limit as anonymous submits', async () => {
  const t = await setupTest();
  try {
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const first = (await (await anonPost(t, token('a'), '198.51.100.1')).json()) as Created;
    const rejected = await mod.post(`/api/changes/${first.changes[0]!.id}/reject`, { reason: 'Not enough' });
    expect(rejected.status).toBe(200);
    const resubmit = (tok: string, ip: string) =>
      t.app.request(`/api/changes/${first.changes[0]!.id}/resubmit`, {
        method: 'POST',
        headers: { 'x-amdb-anon': tok, 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: '{}',
      });
    // The submit above is the 1st request; the first resubmit succeeds, later ones are 409 but still count.
    expect((await resubmit(token('a'), '198.51.100.1')).status).toBe(201);
    for (let i = 0; i < 18; i++) expect((await resubmit(token('a'), '198.51.100.1')).status).toBe(409);
    await expectLimited(await resubmit(token('a'), '198.51.100.1'));
    // The same bucket also stops a plain submit from that address.
    await expectLimited(await anonPost(t, token('b'), '198.51.100.1'));
  } finally {
    await t.close();
  }
});

const tag = (slug: string, ref = 't') => ({
  op: 'create',
  kind: 'tag',
  ref,
  fields: { kind: 'genre', name: `Tag ${slug}`, slug },
});
const extId = (value: string) => ({
  op: 'relate',
  type: 'external_id',
  from: { ref: 'w' },
  data: { scheme: 'imdb', value },
});

describe('duplicate tag slugs and external ids', () => {
  it('a submitted tag whose slug exists is 409 duplicate_slug with existingId', async () => {
    const t = await setupTest();
    try {
      const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const made = await publish(author, mod, [tag('noir')]);
      const res = await author.post('/api/submissions', submission([tag('noir')]));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: 'duplicate_slug', details: { existingId: made.changes[0]!.entityId } },
      });
    } finally {
      await t.close();
    }
  });

  it('a submitted external id that exists is 409 duplicate_external_id with existingId', async () => {
    const t = await setupTest();
    try {
      const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const made = await publish(author, mod, [work, extId('tt2543164')]);
      const res = await author.post('/api/submissions', submission([work, extId('tt2543164')]));
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: 'duplicate_external_id', details: { existingId: made.changes[0]!.entityId } },
      });
    } finally {
      await t.close();
    }
  });

  it('approving a tag whose slug appeared meanwhile is 409 duplicate_slug, and the change stays pending', async () => {
    const t = await setupTest();
    try {
      const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const a = await submit(author, [tag('noir')]);
      const b = await submit(author, [tag('noir')]);
      expect((await mod.post(`/api/changes/${a.changes[0]!.id}/approve`)).status).toBe(200);
      const res = await mod.post(`/api/changes/${b.changes[0]!.id}/approve`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: 'duplicate_slug', details: { existingId: a.changes[0]!.entityId } },
      });
      const detail = (await (await author.get(`/api/submissions/${b.id}`)).json()) as { changes: { status: string }[] };
      expect(detail.changes[0]?.status).toBe('pending');
    } finally {
      await t.close();
    }
  });

  it('approving an external id that appeared meanwhile is 409 duplicate_external_id', async () => {
    const t = await setupTest();
    try {
      const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const a = await submit(author, [work, extId('tt2543164')]);
      const b = await submit(author, [work, extId('tt2543164')]);
      for (const c of a.changes) expect((await mod.post(`/api/changes/${c.id}/approve`)).status).toBe(200);
      expect((await mod.post(`/api/changes/${b.changes[0]!.id}/approve`)).status).toBe(200);
      const res = await mod.post(`/api/changes/${b.changes[1]!.id}/approve`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: { code: 'duplicate_external_id', details: { existingId: a.changes[0]!.entityId } },
      });
    } finally {
      await t.close();
    }
  });
});

it('me/submissions names the entry each change is about, so an edit can be found by its entry', async () => {
  const t = await setupTest();
  try {
    const author = t.as({ kind: 'user', userId: await t.createUser() });
    const moderator = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const made = await publish(author, moderator, [work]);
    const entityId = made.changes[0]?.entityId;
    const edit = await submit(author, [{ op: 'update', kind: 'work', entityId, fields: { releaseYear: 2016 } }]);

    const list = (await (await author.get('/api/me/submissions')).json()) as {
      items: { id: string; changes: { id: string; entityId: string | null; status: string }[] }[];
    };
    expect(list.items.find((s) => s.id === edit.id)?.changes).toEqual([
      expect.objectContaining({ id: edit.changes[0]?.id, entityId, status: 'pending' }),
    ]);
  } finally {
    await t.close();
  }
});
