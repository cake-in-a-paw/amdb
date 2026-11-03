import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { users } from '../src/platform/db/schema';
import { setupAuthTest } from './helpers/auth-app';
import { setupTest } from './helpers/setup';

it('an ADMIN_EMAILS user can make another user a moderator', async () => {
  const t = await setupAuthTest({ adminEmails: 'Boss@Example.test, other@example.test' });
  try {
    const cookie = await t.signInWithCode('boss@example.test');
    const [boss] = await t.db.select().from(users).where(eq(users.email, 'boss@example.test'));
    expect(boss?.role).toBe('admin');

    const [friend] = await t.db
      .insert(users)
      .values({ email: 'friend@example.test', name: 'Friend' })
      .returning({ id: users.id });
    const res = await t.post(`/api/admin/users/${friend!.id}/role`, { role: 'moderator' }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: friend!.id, role: 'moderator' });
    const [after] = await t.db.select().from(users).where(eq(users.id, friend!.id));
    expect(after?.role).toBe('moderator');
  } finally {
    await t.close();
  }
});

it('a sign-up from an address not in ADMIN_EMAILS is a contributor with no name', async () => {
  const t = await setupAuthTest({ adminEmails: 'boss@example.test' });
  try {
    await t.signInWithCode('newbie@example.test');
    const [u] = await t.db.select().from(users).where(eq(users.email, 'newbie@example.test'));
    expect(u?.role).toBe('contributor');
    expect(u?.name).toBeNull();
  } finally {
    await t.close();
  }
});

it('a contributor calling the role endpoint gets 404', async () => {
  const t = await setupTest();
  try {
    const contributor = await t.createUser({ role: 'contributor' });
    const target = await t.createUser();
    const res = await t.as({ kind: 'user', userId: contributor }).post(`/api/admin/users/${target}/role`, {
      role: 'admin',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    const anon = await t.as({ kind: 'anon', token: 'a'.repeat(40) }).post(`/api/admin/users/${target}/role`, {
      role: 'admin',
    });
    expect(anon.status).toBe(404);
  } finally {
    await t.close();
  }
});

it('an admin changing the role of a user that does not exist gets 404', async () => {
  const t = await setupTest();
  try {
    const admin = await t.createUser({ role: 'admin' });
    const res = await t
      .as({ kind: 'user', userId: admin })
      .post(`/api/admin/users/${crypto.randomUUID()}/role`, { role: 'moderator' });
    expect(res.status).toBe(404);
  } finally {
    await t.close();
  }
});
