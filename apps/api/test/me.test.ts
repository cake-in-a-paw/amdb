import { expect, it } from 'vitest';
import { setupTest } from './helpers/setup';

const error = (code: string) => ({ error: { code, message: expect.any(String) } });

it('a signed-out GET /api/me is 401 unauthenticated', async () => {
  const t = await setupTest();
  try {
    for (const who of [{ kind: 'none' }, { kind: 'anon', token: 'a'.repeat(40) }] as const) {
      const res = await t.as(who).get('/api/me');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(error('unauthenticated'));
    }
    expect((await t.as({ kind: 'none' }).patch('/api/me', { handle: 'ann' })).status).toBe(401);
  } finally {
    await t.close();
  }
});

it('GET /api/me returns the account itself', async () => {
  const t = await setupTest();
  try {
    const id = await t.createUser({ role: 'moderator', email: 'me@example.test' });
    const res = await t.as({ kind: 'user', userId: id }).get('/api/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, email: 'me@example.test', handle: null, role: 'moderator' });
  } finally {
    await t.close();
  }
});

it('PATCH /api/me sets, lowercases and clears the handle', async () => {
  const t = await setupTest();
  try {
    const me = t.as({ kind: 'user', userId: await t.createUser() });
    const set = await me.patch('/api/me', { handle: 'Ann_B-1' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { handle: string }).handle).toBe('ann_b-1');
    expect(((await (await me.get('/api/me')).json()) as { handle: string }).handle).toBe('ann_b-1');
    const cleared = await me.patch('/api/me', { handle: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { handle: null }).handle).toBeNull();
  } finally {
    await t.close();
  }
});

it('handles must be 3–30 characters of letters, digits, underscore and hyphen', async () => {
  const t = await setupTest();
  try {
    const me = t.as({ kind: 'user', userId: await t.createUser() });
    for (const handle of ['ab', 'a'.repeat(31), 'has space', 'dot.ted', 'émile', '']) {
      const res = await me.patch('/api/me', { handle });
      expect(res.status, handle).toBe(400);
      expect(await res.json(), handle).toMatchObject(error('invalid_request'));
    }
    expect((await me.patch('/api/me', { handle: 'a'.repeat(30) })).status).toBe(200);
  } finally {
    await t.close();
  }
});

it('a taken handle is 409 handle_taken, ignoring case; your own again is fine', async () => {
  const t = await setupTest();
  try {
    const ann = t.as({ kind: 'user', userId: await t.createUser() });
    const bob = t.as({ kind: 'user', userId: await t.createUser() });
    expect((await ann.patch('/api/me', { handle: 'ann' })).status).toBe(200);
    const res = await bob.patch('/api/me', { handle: 'Ann' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(error('handle_taken'));
    expect((await ann.patch('/api/me', { handle: 'ANN' })).status).toBe(200);
  } finally {
    await t.close();
  }
});

it('reserved handles are 400 handle_reserved', async () => {
  const t = await setupTest();
  try {
    const me = t.as({ kind: 'user', userId: await t.createUser() });
    for (const handle of ['anonymous', 'contributor', 'admin', 'Moderator']) {
      const res = await me.patch('/api/me', { handle });
      expect(res.status, handle).toBe(400);
      expect(await res.json(), handle).toEqual(error('handle_reserved'));
    }
  } finally {
    await t.close();
  }
});
