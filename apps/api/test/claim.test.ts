import { expect, it } from 'vitest';
import { submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const token = 'a'.repeat(40);
const film = (title: string) => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title },
});

it('after claiming, the user sees the anonymous submissions in /api/me/submissions and the old anon token gets 404', async () => {
  const t = await setupTest();
  try {
    const anon = t.as({ kind: 'anon', token });
    const first = await submit(anon, [film('Arrival')]);
    const second = await submit(anon, [film('Sicario')]);
    const userId = await t.createUser();
    const user = t.as({ kind: 'user', userId });
    // A user with the token header too: the session wins for acting, the header names what to claim.
    const both = (path: string) =>
      t.app.request(path, { method: 'POST', headers: { 'x-test-user': userId, 'x-amdb-anon': token } });

    const res = await both('/api/me/claim-anonymous');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ claimed: 2 });

    const mine = (await (await user.get('/api/me/submissions')).json()) as { items: { id: string }[] };
    expect(mine.items.map((s) => s.id).toSorted()).toEqual([first.id, second.id].toSorted());
    expect((await anon.get(`/api/submissions/${first.id}`)).status).toBe(404);
    expect((await user.get(`/api/submissions/${first.id}`)).status).toBe(200);
    expect(((await (await anon.get('/api/me/submissions')).json()) as { items: unknown[] }).items).toHaveLength(0);

    const again = await both('/api/me/claim-anonymous');
    expect(await again.json()).toEqual({ claimed: 0 });
  } finally {
    await t.close();
  }
});

it('claiming needs a session and a well-formed token', async () => {
  const t = await setupTest();
  try {
    const userId = await t.createUser();
    expect((await t.as({ kind: 'anon', token }).post('/api/me/claim-anonymous')).status).toBe(401);
    expect((await t.as({ kind: 'none' }).post('/api/me/claim-anonymous')).status).toBe(401);
    const noToken = await t.as({ kind: 'user', userId }).post('/api/me/claim-anonymous');
    expect(noToken.status).toBe(400);
    const short = await t.app.request('/api/me/claim-anonymous', {
      method: 'POST',
      headers: { 'x-test-user': userId, 'x-amdb-anon': 'short' },
    });
    expect(short.status).toBe(400);
  } finally {
    await t.close();
  }
});
