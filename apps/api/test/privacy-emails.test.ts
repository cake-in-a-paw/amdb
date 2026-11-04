import { expect, it } from 'vitest';
import { publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

/** Constitution I: contributor emails never appear in what the API serves to others. */
it('no response to the public, a moderator or an admin carries a contributor’s email', async () => {
  const t = await setupTest();
  try {
    const authorEmail = 'author.private@example.test';
    const authorId = await t.createUser({ email: authorEmail });
    const modEmail = 'mod.private@example.test';
    const adminEmail = 'admin.private@example.test';
    const author = t.as({ kind: 'user', userId: authorId });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator', email: modEmail }) });
    const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin', email: adminEmail }) });
    const anon = t.as({ kind: 'none' });

    const made = await publish(author, mod, [
      { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'book', subtype: null, title: 'Dune' } },
      { op: 'create', kind: 'creator', ref: 'c', fields: { name: 'Frank Herbert', kind: 'person' } },
      { op: 'relate', type: 'work_creator', from: { ref: 'w' }, to: { ref: 'c' }, data: { role: 'author' } },
    ]);
    const workId = made.changes[0]!.entityId!;
    const pending = await submit(author, [
      { op: 'update', kind: 'work', entityId: workId, fields: { description: 'Desert planet' } },
    ]);
    const rejected = await submit(author, [
      { op: 'update', kind: 'work', entityId: workId, fields: { title: 'Doon' } },
    ]);
    expect((await mod.post(`/api/changes/${rejected.changes[0]!.id}/reject`, { reason: 'Typo' })).status).toBe(200);

    const responses: [string, Response][] = [];
    for (const [who, client] of [
      ['public', anon],
      ['moderator', mod],
      ['admin', admin],
    ] as const) {
      for (const path of [
        `/api/entities/${workId}`,
        `/api/entities/${workId}/history`,
        `/api/entities/${made.changes[1]!.entityId}`,
        '/api/search?q=dune',
        '/api/duplicates?kind=work&title=Dune',
        '/api/moderation/queue',
        `/api/submissions/${made.id}`,
        `/api/submissions/${pending.id}`,
        `/api/submissions/${rejected.id}`,
      ]) {
        responses.push([`${who} GET ${path}`, await client.get(path)]);
      }
    }
    // The moderator's and admin's own actions answer without anyone's email.
    responses.push(['moderator approve', await mod.post(`/api/changes/${pending.changes[0]!.id}/approve`)]);
    responses.push(['moderator revert', await mod.post(`/api/changes/${pending.changes[0]!.id}/revert`)]);
    responses.push(['admin role', await admin.post(`/api/admin/users/${authorId}/role`, { role: 'contributor' })]);

    let served = 0;
    for (const [label, res] of responses) {
      const body = await res.text();
      if (res.status === 200) served += 1;
      for (const email of [authorEmail, modEmail, adminEmail]) expect(body, label).not.toContain(email);
      expect(body, label).not.toContain('private@');
    }
    // Most of these are real answers, not 404s that trivially hold no email.
    expect(served).toBeGreaterThanOrEqual(20);
  } finally {
    await t.close();
  }
});

it('public attribution is the handle or nothing: never an email, the OAuth profile name or the account id', async () => {
  const t = await setupTest();
  try {
    const authorId = await t.createUser({ email: 'real@example.com', name: 'Real Name' });
    const author = t.as({ kind: 'user', userId: authorId });
    const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
    const anon = t.as({ kind: 'none' });

    const made = await publish(author, mod, [
      { op: 'create', kind: 'work', ref: 'w', fields: { mediaType: 'book', subtype: null, title: 'Dune' } },
    ]);
    const workId = made.changes[0]!.entityId!;
    const historyOf = async () => {
      const res = await anon.get(`/api/entities/${workId}/history`);
      expect(res.status).toBe(200);
      const text = await res.text();
      return { text, body: JSON.parse(text) as { items: { author: unknown }[] } };
    };

    const before = await historyOf();
    // Without a handle, nothing public links one contributor's changes together.
    expect(before.body.items[0]!.author).toEqual({ handle: null });
    expect(before.text).not.toContain(authorId);
    const entity = await (await anon.get(`/api/entities/${workId}`)).text();
    for (const text of [before.text, entity]) {
      expect(text).not.toContain('Real Name');
      expect(text).not.toContain('real@example.com');
    }

    expect((await author.patch('/api/me', { handle: 'ann' })).status).toBe(200);
    const after = await historyOf();
    expect(after.body.items[0]!.author).toEqual({ handle: 'ann' });
    expect(after.text).not.toContain(authorId);
    expect(after.text).not.toContain('Real Name');
    expect(after.text).not.toContain('real@example.com');

    const queued = await submit(author, [
      { op: 'update', kind: 'work', entityId: workId, fields: { description: 'x' } },
    ]);
    const queue = (await (await mod.get('/api/moderation/queue')).json()) as {
      items: { submission: { id: string; author: unknown } }[];
    };
    expect(queue.items.find((i) => i.submission.id === queued.id)?.submission.author).toEqual({
      userId: authorId,
      handle: 'ann',
    });
  } finally {
    await t.close();
  }
});
