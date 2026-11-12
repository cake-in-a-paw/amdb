import { and, eq, isNull } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { relations } from '../src/platform/db/schema';
import { type Created, publish, submit, submission } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (ref: string, subtype: string | null, title = ref) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: subtype === null ? { mediaType: 'book', subtype, title } : { mediaType: 'film_tv', subtype, title },
});
type End = { ref: string } | { id: string };
const end = (x: string | End): End => (typeof x === 'string' ? { ref: x } : x);
const partOf = (parent: string | End, child: string | End, position?: number) => ({
  op: 'relate',
  type: 'work_part',
  from: end(parent),
  to: end(child),
  data: position === undefined ? {} : { position },
});
const update = (entityId: string, fields: Record<string, unknown>) => ({
  op: 'update',
  kind: 'work',
  entityId,
  fields,
});
const unrelate = (relationId: string) => ({ op: 'unrelate', relationId });
type ErrorBody = { error: { code: string; details?: unknown } };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const admin = t.as({ kind: 'user', userId: await t.createUser({ role: 'admin' }) });
  /** The entity a create in `created` made, by index. */
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
  /** The live work_part rows under `parentId`, as [childId, position]. */
  const partsOf = async (parentId: string) =>
    (
      await t.db
        .select({ to: relations.toId, position: relations.position })
        .from(relations)
        .where(and(eq(relations.type, 'work_part'), eq(relations.fromId, parentId), isNull(relations.removedByChange)))
    ).map((r) => [r.to, r.position]);
  /** The live parent link of `childId`. */
  const parentLink = async (childId: string) => {
    const [row] = await t.db
      .select({ id: relations.id, from: relations.fromId })
      .from(relations)
      .where(and(eq(relations.type, 'work_part'), eq(relations.toId, childId), isNull(relations.removedByChange)));
    return row ?? null;
  };
  const expectError = async (res: Response, status: number, code: string) => {
    const text = await res.clone().text();
    expect(res.status, text).toBe(status);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code, text).toBe(code);
    return body.error;
  };
  const submitRes = (changes: unknown[]) => author.post('/api/submissions', submission(changes));
  const approve = (id: string) => mod.post(`/api/changes/${id}/approve`);
  const revert = (id: string) => mod.post(`/api/changes/${id}/revert`);
  const removeEntity = async (createChangeId: string) => {
    const res = await admin.post(`/api/admin/changes/${createChangeId}/redact`, {
      reason: 'Abuse',
      removeEntity: true,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const statusOf = async (id: string) =>
    ((await (await mod.get(`/api/changes/${id}`)).json()) as { status: string }).status;
  return {
    t,
    author,
    mod,
    idOf,
    changeOf,
    partsOf,
    parentLink,
    expectError,
    submitRes,
    approve,
    revert,
    removeEntity,
    statusOf,
  };
}

/** A published show with season A (and season B) and episode under A. */
async function tree(s: Awaited<ReturnType<typeof setup>>) {
  const made = await publish(s.author, s.mod, [
    work('show', 'series'),
    work('a', 'season'),
    work('b', 'season'),
    work('ep', 'episode'),
    partOf('show', 'a', 1),
    partOf('show', 'b', 2),
    partOf('a', 'ep', 1),
  ]);
  return {
    made,
    show: s.idOf(made, 0),
    a: s.idOf(made, 1),
    b: s.idOf(made, 2),
    ep: s.idOf(made, 3),
    epLink: s.changeOf(made, 6),
  };
}

it('show, season and episode relate and read back', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('season', 'season'),
      work('ep', 'episode'),
      work('ep2', 'episode'),
      partOf('show', 'season', 2),
      partOf('season', 'ep', 14),
      partOf('season', 'ep2'),
    ]);
    const [show, season, ep, ep2] = [0, 1, 2, 3].map((i) => s.idOf(made, i));
    expect(await s.partsOf(show!)).toEqual([[season, 2]]);
    expect((await s.partsOf(season!)).toSorted()).toEqual(
      [
        [ep, 14],
        [ep2, null],
      ].toSorted(),
    );
  } finally {
    await s.t.close();
  }
});

it('episode 0 and season 0 are accepted', async () => {
  const s = await setup();
  try {
    const res = await s.submitRes([
      work('show', 'series'),
      work('s0', 'season'),
      work('e0', 'episode'),
      partOf('show', 's0', 0),
      partOf('s0', 'e0', 0),
    ]);
    expect(res.status, await res.clone().text()).toBe(201);
  } finally {
    await s.t.close();
  }
});

it('film as part of a series is 400 invalid_tree', async () => {
  const s = await setup();
  try {
    const error = await s.expectError(
      await s.submitRes([work('show', 'series'), work('film', 'movie'), partOf('show', 'film')]),
      400,
      'invalid_tree',
    );
    expect(error.details).toEqual({ parentSubtype: 'series', childSubtype: 'movie' });
  } finally {
    await s.t.close();
  }
});

it('episode under a movie is 400 invalid_tree', async () => {
  const s = await setup();
  try {
    await s.expectError(
      await s.submitRes([work('film', 'movie'), work('ep', 'episode'), partOf('film', 'ep')]),
      400,
      'invalid_tree',
    );
  } finally {
    await s.t.close();
  }
});

it('work as its own part is 400 invalid_tree', async () => {
  const s = await setup();
  try {
    await s.expectError(await s.submitRes([work('show', 'series'), partOf('show', 'show')]), 400, 'invalid_tree');
  } finally {
    await s.t.close();
  }
});

it('second parent is 409 has_parent', async () => {
  const s = await setup();
  try {
    const { b, ep } = await tree(s);
    const link = await s.parentLink(ep);
    const error = await s.expectError(await s.submitRes([partOf({ id: b }, { id: ep })]), 409, 'has_parent');
    expect(error.details).toEqual({ relationId: link?.id });
  } finally {
    await s.t.close();
  }
});

it('move in one submission', async () => {
  const s = await setup();
  try {
    const { b, ep } = await tree(s);
    const link = await s.parentLink(ep);
    await publish(s.author, s.mod, [unrelate(link!.id), partOf({ id: b }, { id: ep }, 3)]);
    expect((await s.parentLink(ep))?.from).toBe(b);
  } finally {
    await s.t.close();
  }
});

it('second pending parent is 409 on approve', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('a', 'season'),
      work('b', 'season'),
      work('ep', 'episode'),
    ]);
    const [a, b, ep] = [1, 2, 3].map((i) => s.idOf(made, i));
    const viaA = await submit(s.author, [partOf({ id: a! }, { id: ep! })]);
    const viaB = await submit(s.author, [partOf({ id: b! }, { id: ep! })]);
    expect((await s.approve(s.changeOf(viaA, 0))).status).toBe(200);
    const linkA = await s.parentLink(ep!);
    const error = await s.expectError(await s.approve(s.changeOf(viaB, 0)), 409, 'has_parent');
    expect(error.details).toEqual({ relationId: linkA?.id });
    expect(await s.statusOf(s.changeOf(viaB, 0))).toBe('pending');
  } finally {
    await s.t.close();
  }
});

it('revert of a detach after a move is 409', async () => {
  const s = await setup();
  try {
    const { b, ep } = await tree(s);
    const link = await s.parentLink(ep);
    const detach = await publish(s.author, s.mod, [unrelate(link!.id)]);
    await publish(s.author, s.mod, [partOf({ id: b }, { id: ep })]);
    await s.expectError(await s.revert(s.changeOf(detach, 0)), 409, 'has_parent');
    expect((await s.parentLink(ep))?.from).toBe(b);
  } finally {
    await s.t.close();
  }
});

it('subtype change that breaks the tree is refused', async () => {
  const s = await setup();
  try {
    const { a, ep } = await tree(s);
    const toMovie = await submit(s.author, [update(a, { subtype: 'movie' })]);
    await s.expectError(await s.approve(s.changeOf(toMovie, 0)), 409, 'invalid_tree');
    const toBook = await submit(s.author, [update(ep, { mediaType: 'book', subtype: null })]);
    await s.expectError(await s.approve(s.changeOf(toBook, 0)), 409, 'invalid_tree');
  } finally {
    await s.t.close();
  }
});

it('pending relate then subtype change', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [work('season', 'season'), work('ep', 'episode')]);
    const [season, ep] = [0, 1].map((i) => s.idOf(made, i));
    const relate = await submit(s.author, [partOf({ id: season! }, { id: ep! })]);
    await publish(s.author, s.mod, [update(season!, { subtype: 'movie' })]);
    await s.expectError(await s.approve(s.changeOf(relate, 0)), 409, 'invalid_tree');
  } finally {
    await s.t.close();
  }
});

it('revert restores a subtype only if the tree allows', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [work('w', 'movie'), work('season', 'season')]);
    const [w, season] = [0, 1].map((i) => s.idOf(made, i));
    const toSeries = await publish(s.author, s.mod, [update(w!, { subtype: 'series' })]);
    await publish(s.author, s.mod, [partOf({ id: w! }, { id: season! })]);
    await s.expectError(await s.revert(s.changeOf(toSeries, 0)), 409, 'invalid_tree');
  } finally {
    await s.t.close();
  }
});

it('part under a removed show can still be edited', async () => {
  const s = await setup();
  try {
    const { made, a } = await tree(s);
    await s.removeEntity(s.changeOf(made, 0));
    const edit = await submit(s.author, [update(a, { subtype: 'season', description: 'The first season' })]);
    expect((await s.approve(s.changeOf(edit, 0))).status).toBe(200);
    const more = await submit(s.author, [work('ep2', 'episode'), partOf({ id: a }, 'ep2', 2)]);
    expect((await s.approve(s.changeOf(more, 0))).status).toBe(200);
    expect((await s.approve(s.changeOf(more, 1))).status).toBe(200);
  } finally {
    await s.t.close();
  }
});

it('series membership of a part is invalid_relation', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      { op: 'create', kind: 'series', ref: 'saga', fields: { title: 'Saga' } },
      work('ep', 'episode'),
      work('m1', 'movie'),
      work('m2', 'movie'),
    ]);
    const [saga, ep, m1, m2] = [0, 1, 2, 3].map((i) => s.idOf(made, i));
    const inSaga = (w: string, position: number) => ({
      op: 'relate',
      type: 'series_work',
      from: { id: saga },
      to: { id: w },
      data: { position },
    });
    // At plan time.
    await s.expectError(await s.submitRes([inSaga(ep!, 1)]), 400, 'invalid_relation');
    // A pending membership, then the movie becomes an episode.
    const pending = await submit(s.author, [inSaga(m1!, 1)]);
    await publish(s.author, s.mod, [update(m1!, { subtype: 'episode' })]);
    await s.expectError(await s.approve(s.changeOf(pending, 0)), 409, 'invalid_relation');
    // A live membership, then the movie becomes an episode.
    await publish(s.author, s.mod, [inSaga(m2!, 2)]);
    const toEpisode = await submit(s.author, [update(m2!, { subtype: 'episode' })]);
    await s.expectError(await s.approve(s.changeOf(toEpisode, 0)), 409, 'invalid_relation');
  } finally {
    await s.t.close();
  }
});

it('revert of a detach to a removed parent is 409 entity_unavailable', async () => {
  const s = await setup();
  try {
    const { made, ep } = await tree(s);
    const link = await s.parentLink(ep);
    const detach = await publish(s.author, s.mod, [unrelate(link!.id)]);
    // Season A's create is change 1.
    await s.removeEntity(s.changeOf(made, 1));
    await s.expectError(await s.revert(s.changeOf(detach, 0)), 409, 'entity_unavailable');
    expect(await s.parentLink(ep)).toBeNull();
  } finally {
    await s.t.close();
  }
});

it('revert a show’s create waits for its parts', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('season', 'season'),
      work('ep', 'episode'),
      partOf('show', 'season', 1),
      partOf('season', 'ep', 1),
    ]);
    await s.expectError(await s.revert(s.changeOf(made, 0)), 409, 'has_dependents');
    expect((await s.revert(s.changeOf(made, 3))).status).toBe(200);
    expect((await s.revert(s.changeOf(made, 0))).status).toBe(200);
  } finally {
    await s.t.close();
  }
});

it('rejecting a pending show rejects only the link that depends on it', async () => {
  const s = await setup();
  try {
    const made = await submit(s.author, [
      work('show', 'series'),
      work('season', 'season'),
      work('ep', 'episode'),
      partOf('show', 'season', 1),
      partOf('season', 'ep', 1),
    ]);
    const res = await s.mod.post(`/api/changes/${s.changeOf(made, 0)}/reject`, { reason: 'Not a real show' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await s.statusOf(s.changeOf(made, 3))).toBe('rejected');
    for (const i of [1, 2, 4]) expect(await s.statusOf(s.changeOf(made, i))).toBe('pending');
  } finally {
    await s.t.close();
  }
});

/** A published series and a published property, and the relates that put `work` in them. */
async function groupings(s: Awaited<ReturnType<typeof setup>>) {
  const made = await publish(s.author, s.mod, [
    { op: 'create', kind: 'series', ref: 'saga', fields: { title: 'Saga' } },
    { op: 'create', kind: 'property', ref: 'franchise', fields: { title: 'Franchise' } },
  ]);
  const [saga, franchise] = [0, 1].map((i) => s.idOf(made, i));
  return {
    inSaga: (w: string, position = 1) => ({
      op: 'relate',
      type: 'series_work',
      from: { id: saga },
      to: { id: w },
      data: { position },
    }),
    inFranchise: (w: string) => ({
      op: 'relate',
      type: 'property_work',
      from: { id: franchise },
      to: { id: w },
      data: {},
    }),
  };
}

it('revert of an unrelate never puts a part back in a series or a property', async () => {
  const s = await setup();
  try {
    const { inSaga, inFranchise } = await groupings(s);
    const film = s.idOf(await publish(s.author, s.mod, [work('film', 'movie')]), 0);
    await publish(s.author, s.mod, [inSaga(film), inFranchise(film)]);
    const live = async () =>
      (
        await s.t.db
          .select({ id: relations.id, type: relations.type })
          .from(relations)
          .where(and(eq(relations.toId, film), isNull(relations.removedByChange)))
      ).map((r) => r.type);
    const rows = await s.t.db.select({ id: relations.id }).from(relations).where(eq(relations.toId, film));
    expect(rows).toHaveLength(2);
    const detach = await publish(
      s.author,
      s.mod,
      rows.map((r) => unrelate(r.id)),
    );
    await publish(s.author, s.mod, [update(film, { subtype: 'episode' })]);
    for (const i of [0, 1]) {
      const error = await s.expectError(await s.revert(s.changeOf(detach, i)), 409, 'invalid_relation');
      expect(error.details).toEqual({ workId: film });
    }
    expect(await live()).toEqual([]);
  } finally {
    await s.t.close();
  }
});

it('a retype earlier in a submission counts for the tree checks after it', async () => {
  const s = await setup();
  try {
    const { inSaga } = await groupings(s);
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('season', 'season'),
      work('film', 'movie'),
      work('stray', 'episode'),
    ]);
    const [season, film, stray] = [1, 2, 3].map((i) => s.idOf(made, i));
    // A movie becomes an episode and goes under a season in one submission.
    await publish(s.author, s.mod, [update(film!, { subtype: 'episode' }), partOf({ id: season! }, { id: film! }, 1)]);
    expect((await s.parentLink(film!))?.from).toBe(season);
    // An unattached episode becomes a movie and joins a series.
    await publish(s.author, s.mod, [update(stray!, { subtype: 'movie' }), inSaga(stray!)]);
    // A movie that becomes an episode can't join a series in the same submission.
    const movie = s.idOf(await publish(s.author, s.mod, [work('m', 'movie')]), 0);
    await s.expectError(
      await s.submitRes([update(movie, { subtype: 'episode' }), inSaga(movie)]),
      400,
      'invalid_relation',
    );
    // Nor can a season that stops being one go under a show.
    const loose = s.idOf(await publish(s.author, s.mod, [work('loose', 'season')]), 0);
    await s.expectError(
      await s.submitRes([update(loose, { subtype: 'movie' }), partOf({ id: s.idOf(made, 0) }, { id: loose })]),
      400,
      'invalid_tree',
    );
  } finally {
    await s.t.close();
  }
});

it('two relates making one work a part in one submission are refused at plan time', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [work('show', 'series'), work('a', 'season'), work('ep', 'episode')]);
    const [show, a, ep] = [0, 1, 2].map((i) => s.idOf(made, i));
    await s.expectError(
      await s.submitRes([partOf({ id: show! }, { id: ep! }), partOf({ id: a! }, { id: ep! })]),
      409,
      'has_parent',
    );
  } finally {
    await s.t.close();
  }
});

it('position 0 is for parts only; series and credits start at 1', async () => {
  const s = await setup();
  try {
    const { inSaga } = await groupings(s);
    const made = await publish(s.author, s.mod, [
      work('film', 'movie'),
      { op: 'create', kind: 'creator', ref: 'dir', fields: { kind: 'person', name: 'Director' } },
    ]);
    const [film, dir] = [0, 1].map((i) => s.idOf(made, i));
    const credit = (position: number) => ({
      op: 'relate',
      type: 'work_creator',
      from: { id: film },
      to: { id: dir },
      data: { role: 'director', position },
    });
    for (const change of [inSaga(film!, 0), credit(0)]) {
      const error = await s.expectError(await s.submitRes([change]), 400, 'invalid_request');
      expect(error.details).toEqual([expect.objectContaining({ path: 'changes.0.data.position' })]);
    }
    expect((await s.submitRes([inSaga(film!, 1), credit(1)])).status).toBe(201);
  } finally {
    await s.t.close();
  }
});
