import { expect, it } from 'vitest';
import { publish, submission } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (fields: Record<string, unknown> = {}) => ({
  op: 'create',
  kind: 'work',
  ref: 'w',
  fields: { mediaType: 'film_tv', subtype: 'movie', title: 'Nineteen Eighty-Four', ...fields },
});
const creator = (fields: Record<string, unknown> = {}) => ({
  op: 'create',
  kind: 'creator',
  ref: 'c',
  fields: { name: 'George Orwell', kind: 'person', ...fields },
});
const update = (kind: 'work' | 'creator', entityId: string, fields: Record<string, unknown>) => ({
  op: 'update',
  kind,
  entityId,
  fields,
});

type Entity = { fields: Record<string, unknown>; fieldSources: Record<string, string> };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  const entity = async (id: string) => (await (await anon.get(`/api/entities/${id}`)).json()) as Entity;
  const rejected = async (changes: unknown[]) => {
    const res = await author.post('/api/submissions', submission(changes));
    expect(res.status).toBe(400);
    return ((await res.json()) as { error: { code: string; details?: unknown } }).error;
  };
  return { t, author, mod, entity, rejected };
}

it('create with names shows them', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const created = await publish(author, mod, [work({ alternateTitles: ['1984', 'Nineteen 84'] })]);
    expect((await entity(created.changes[0]!.entityId!)).fields.alternateTitles).toEqual(['1984', 'Nineteen 84']);
    const plain = await publish(author, mod, [work({ title: 'Animal Farm' })]);
    expect((await entity(plain.changes[0]!.entityId!)).fields.alternateTitles).toEqual([]);
    expect(Object.keys((await entity(plain.changes[0]!.entityId!)).fields)).not.toContain('alternateTitlesNorm');
  } finally {
    await t.close();
  }
});

it('update replaces the list', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const id = (await publish(author, mod, [work({ alternateTitles: ['A', 'B'] })])).changes[0]!.entityId!;
    await publish(author, mod, [update('work', id, { alternateTitles: ['C'] })]);
    expect((await entity(id)).fields.alternateTitles).toEqual(['C']);
  } finally {
    await t.close();
  }
});

it('revert restores the previous list exactly', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const created = await publish(author, mod, [work()]);
    const id = created.changes[0]!.entityId!;
    const first = await publish(author, mod, [update('work', id, { alternateTitles: ['A', 'B'] })]);
    const second = await publish(author, mod, [update('work', id, { alternateTitles: ['C'] })]);
    const res = await mod.post(`/api/changes/${second.changes[0]!.id}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
    const after = await entity(id);
    expect(after.fields.alternateTitles).toEqual(['A', 'B']);
    expect(after.fieldSources.alternateTitles).toBe(first.changes[0]!.id);
  } finally {
    await t.close();
  }
});

it('a name equal to the title is 400 duplicate_name', async () => {
  const { t, rejected } = await setup();
  try {
    const err = await rejected([work({ alternateTitles: ['Nineteen eighty-four'] })]);
    expect(err.code).toBe('duplicate_name');
    expect(err.details).toEqual({ field: 'alternateTitles', index: 0 });
    const again = await rejected([work({ originalTitle: 'Orig', alternateTitles: ['ok', 'ORIG'] })]);
    expect(again.details).toEqual({ field: 'alternateTitles', index: 1 });
  } finally {
    await t.close();
  }
});

it('51 names is 400 too_many_names', async () => {
  const { t, rejected } = await setup();
  try {
    const names = Array.from({ length: 51 }, (_, i) => `Name ${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i)}`);
    expect((await rejected([work({ alternateTitles: names })])).code).toBe('too_many_names');
  } finally {
    await t.close();
  }
});

it('an update is checked against the current title and original title', async () => {
  const { t, author, mod, rejected } = await setup();
  try {
    const id = (await publish(author, mod, [work({ originalTitle: 'Orwell Original' })])).changes[0]!.entityId!;
    const err = await rejected([update('work', id, { alternateTitles: ['orwell original'] })]);
    expect(err).toMatchObject({ code: 'duplicate_name', details: { field: 'alternateTitles', index: 0 } });
    const merged = await rejected([update('work', id, { title: 'X', alternateTitles: ['x'] })]);
    expect(merged.code).toBe('duplicate_name');
  } finally {
    await t.close();
  }
});

it('a title edit that leaves a now-duplicate name is accepted', async () => {
  const { t, author, mod, entity } = await setup();
  try {
    const id = (await publish(author, mod, [work({ alternateTitles: ['1984'] })])).changes[0]!.entityId!;
    await publish(author, mod, [update('work', id, { title: '1984' })]);
    const fields = (await entity(id)).fields;
    expect(fields.title).toBe('1984');
    expect(fields.alternateTitles).toEqual(['1984']);
  } finally {
    await t.close();
  }
});

it('creators: create, update, and duplicate checks for alternateNames', async () => {
  const { t, author, mod, entity, rejected } = await setup();
  try {
    const id = (await publish(author, mod, [creator({ alternateNames: ['Eric Blair'] })])).changes[0]!.entityId!;
    expect((await entity(id)).fields.alternateNames).toEqual(['Eric Blair']);
    await publish(author, mod, [update('creator', id, { alternateNames: ['E. A. Blair', 'Blair'] })]);
    expect((await entity(id)).fields.alternateNames).toEqual(['E. A. Blair', 'Blair']);
    expect(Object.keys((await entity(id)).fields)).not.toContain('alternateNamesNorm');
    const err = await rejected([update('creator', id, { alternateNames: ['Blair', 'george ORWELL'] })]);
    expect(err).toMatchObject({ code: 'duplicate_name', details: { field: 'alternateNames', index: 1 } });
    expect((await rejected([creator({ alternateNames: ['George Orwell'] })])).code).toBe('duplicate_name');
  } finally {
    await t.close();
  }
});
