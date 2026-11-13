import { expect } from 'vitest';
import { type Created, publish } from './catalog';
import { setupTest } from './setup';

/** A relation end: a ref to a create in the same submission, or a live entity's id. */
export type End = { ref: string } | { id: string };
const end = (x: string | End): End => (typeof x === 'string' ? { ref: x } : x);

export const work = (ref: string, subtype: string, title = ref) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title },
});
export const creator = (ref: string, name = ref) => ({
  op: 'create',
  kind: 'creator',
  ref,
  fields: { kind: 'person', name },
});
export const partOf = (parent: string, child: string, position: number) => ({
  op: 'relate',
  type: 'work_part',
  from: { ref: parent },
  to: { ref: child },
  data: { position },
});
export const credit = (w: string | End, c: string | End, role: string) => ({
  op: 'relate',
  type: 'work_creator',
  from: end(w),
  to: end(c),
  data: { role },
});

/** A test app with an author, a moderator and an anonymous client, and helpers for credits tests. */
export async function setupCredits() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin' }) });
  const anon = t.as({ kind: 'none' });
  const idOf = (created: Created, i: number) => {
    const id = created.changes[i]?.entityId;
    if (!id) throw new Error(`change ${i} has no entity`);
    return id;
  };
  const changeOf = (created: Created, i: number) => {
    const id = created.changes[i]?.id;
    if (!id) throw new Error(`no change ${i}`);
    return id;
  };
  /** Takes down the entity `createChangeId` made, as an admin. */
  const removeEntity = async (createChangeId: string) => {
    const res = await admin.post(`/api/admin/changes/${createChangeId}/redact`, {
      reason: 'Abuse',
      removeEntity: true,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  return { t, author, mod, anon, idOf, changeOf, removeEntity };
}

/**
 * Creator C; film F; show S with seasons S1 and S2, episodes E11 and E12 under S1, E21 under S2,
 * episode X directly under S; and orphan episode O. C is credited on F (twice), S, S2, every
 * episode under S, and O.
 */
export async function creditsFixture(s: Awaited<ReturnType<typeof setupCredits>>) {
  const made = await publish(s.author, s.mod, [
    creator('C'),
    work('F', 'movie'),
    work('S', 'series'),
    work('S1', 'season'),
    work('S2', 'season'),
    work('E11', 'episode'),
    work('E12', 'episode'),
    work('E21', 'episode'),
    work('X', 'episode'),
    work('O', 'episode'),
    partOf('S', 'S1', 1),
    partOf('S', 'S2', 2),
    partOf('S1', 'E11', 1),
    partOf('S1', 'E12', 2),
    partOf('S2', 'E21', 1),
    partOf('S', 'X', 5),
    credit('F', 'C', 'director'),
    credit('S', 'C', 'producer'),
    credit('E11', 'C', 'writer'),
    credit('E12', 'C', 'director'),
    credit('E21', 'C', 'director'),
    credit('S2', 'C', 'director'),
    credit('X', 'C', 'director'),
    credit('O', 'C', 'writer'),
    credit('F', 'C', 'writer'),
  ]);
  return {
    c: s.idOf(made, 0),
    f: s.idOf(made, 1),
    show: s.idOf(made, 2),
    s1: s.idOf(made, 3),
    s2: s.idOf(made, 4),
    e11: s.idOf(made, 5),
    e12: s.idOf(made, 6),
    e21: s.idOf(made, 7),
    x: s.idOf(made, 8),
    o: s.idOf(made, 9),
    fCreate: s.changeOf(made, 1),
    showCreate: s.changeOf(made, 2),
  };
}
