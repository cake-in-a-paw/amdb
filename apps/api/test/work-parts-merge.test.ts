import { and, eq, isNull } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { relations } from '../src/platform/db/schema';
import { type Created, publish, submit } from './helpers/catalog';
import { setupTest } from './helpers/setup';

const work = (ref: string, subtype: string, title = ref) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype, title },
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
const merge = (from: string, into: string) => ({ op: 'merge', kind: 'work', from, into });
const unrelate = (relationId: string) => ({ op: 'unrelate', relationId });
type ErrorBody = { error: { code: string; details?: unknown } };

async function setup() {
  const t = await setupTest();
  const author = t.as({ kind: 'user', userId: await t.createUser() });
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
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
  /** The live parent link of `childId` as `{ id, from, position }`, or null. */
  const parentLink = async (childId: string) => {
    const [row] = await t.db
      .select({ id: relations.id, from: relations.fromId, position: relations.position })
      .from(relations)
      .where(and(eq(relations.type, 'work_part'), eq(relations.toId, childId), isNull(relations.removedByChange)));
    return row ?? null;
  };
  /** The live parts of `parentId` as sorted [childId, position] pairs. */
  const partsOf = async (parentId: string) =>
    (
      await t.db
        .select({ to: relations.toId, position: relations.position })
        .from(relations)
        .where(and(eq(relations.type, 'work_part'), eq(relations.fromId, parentId), isNull(relations.removedByChange)))
    )
      .map((r) => [r.to, r.position] as const)
      .toSorted((x, y) => String(x[0]).localeCompare(String(y[0])));
  /** Each work's parent link (without its id) and parts: the tree as it stands around `ids`. */
  const treeOf = async (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        const link = await parentLink(id);
        return { id, parent: link && { from: link.from, position: link.position }, parts: await partsOf(id) };
      }),
    );
  const expectError = async (res: Response, status: number, code: string) => {
    const text = await res.clone().text();
    expect(res.status, text).toBe(status);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code, text).toBe(code);
    return body.error;
  };
  const approve = (id: string) => mod.post(`/api/changes/${id}/approve`);
  const revert = async (id: string) => {
    const res = await mod.post(`/api/changes/${id}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
  };
  const mergeLive = async (from: string, into: string) => changeOf(await publish(author, mod, [merge(from, into)]), 0);
  const statusOf = async (id: string) =>
    ((await (await mod.get(`/api/changes/${id}`)).json()) as { status: string }).status;
  return {
    t,
    author,
    mod,
    anon,
    idOf,
    changeOf,
    parentLink,
    partsOf,
    treeOf,
    expectError,
    approve,
    revert,
    mergeLive,
    statusOf,
  };
}

/** Two copies of a show, each with a "Season 1" holding two episodes. */
async function twoShows(s: Awaited<ReturnType<typeof setup>>) {
  const copy = async () => {
    const made = await publish(s.author, s.mod, [
      work('show', 'series', 'The Show'),
      work('s1', 'season', 'Season 1'),
      work('e1', 'episode', 'Pilot'),
      work('e2', 'episode', 'Second'),
      partOf('show', 's1', 1),
      partOf('s1', 'e1', 1),
      partOf('s1', 'e2', 2),
    ]);
    return { show: s.idOf(made, 0), season: s.idOf(made, 1), eps: [s.idOf(made, 2), s.idOf(made, 3)] };
  };
  const a = await copy();
  const b = await copy();
  return { a, b, all: [a.show, b.show, a.season, b.season, ...a.eps, ...b.eps] };
}

it('merging two copies of a show gathers seasons', async () => {
  const s = await setup();
  try {
    const { a, b } = await twoShows(s);
    await s.mergeLive(b.show, a.show);
    expect(await s.partsOf(a.show)).toEqual(
      [
        [a.season, 1],
        [b.season, 1],
      ].toSorted((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    const seasonLink = await s.parentLink(b.season);
    await s.mergeLive(b.season, a.season);
    expect((await s.partsOf(a.season)).map(([id]) => id).toSorted()).toEqual([...a.eps, ...b.eps].toSorted());
    // B's season link was a duplicate of A's own (same parent, position ignored): dropped, not moved.
    expect(await s.partsOf(a.show)).toEqual([[a.season, 1]]);
    const [dropped] = await s.t.db.select().from(relations).where(eq(relations.id, seasonLink!.id));
    expect(dropped?.removedByChange).not.toBeNull();
  } finally {
    await s.t.close();
  }
});

it('unmerging in reverse order restores the tree exactly', async () => {
  const s = await setup();
  try {
    const { a, b, all } = await twoShows(s);
    const before = await s.treeOf(all);
    const showMerge = await s.mergeLive(b.show, a.show);
    const seasonMerge = await s.mergeLive(b.season, a.season);
    await s.revert(seasonMerge);
    await s.revert(showMerge);
    expect(await s.treeOf(all)).toEqual(before);
    // Both losers answer as themselves again, not as a redirect.
    for (const id of [b.show, b.season]) expect((await s.anon.get(`/api/entities/${id}`)).status).toBe(200);
  } finally {
    await s.t.close();
  }
});

it('unmerging the show first is 409, not 500', async () => {
  const s = await setup();
  try {
    const { a, b, all } = await twoShows(s);
    const showMerge = await s.mergeLive(b.show, a.show);
    await s.mergeLive(b.season, a.season);
    const merged = await s.treeOf(all);
    await s.expectError(await s.mod.post(`/api/changes/${showMerge}/revert`), 409, 'stale_change');
    expect(await s.treeOf(all)).toEqual(merged);
  } finally {
    await s.t.close();
  }
});

it('merging episodes under different seasons is 409 conflicting_parents', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('s1', 'season'),
      work('s2', 'season'),
      work('e1', 'episode'),
      work('e2', 'episode'),
      partOf('show', 's1', 1),
      partOf('show', 's2', 2),
      partOf('s1', 'e1', 1),
      partOf('s2', 'e2', 1),
    ]);
    const ids = [0, 1, 2, 3, 4].map((i) => s.idOf(made, i));
    const [, s1, s2, e1, e2] = ids;
    const before = await s.treeOf(ids);
    const pending = await submit(s.author, [merge(e2!, e1!)]);
    const error = await s.expectError(await s.approve(s.changeOf(pending, 0)), 409, 'conflicting_parents');
    expect(error.details).toEqual({ fromParent: s2, intoParent: s1 });
    expect(await s.treeOf(ids)).toEqual(before);
    expect(await s.statusOf(s.changeOf(pending, 0))).toBe('pending');
  } finally {
    await s.t.close();
  }
});

it('merging a season into a film is 409 invalid_tree', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('season', 'season'),
      work('e1', 'episode'),
      work('e2', 'episode'),
      work('film', 'movie'),
      partOf('season', 'e1', 1),
      partOf('season', 'e2', 2),
    ]);
    const ids = [0, 1, 2, 3].map((i) => s.idOf(made, i));
    const [season, , , film] = ids;
    const before = await s.treeOf(ids);
    const pending = await submit(s.author, [merge(season!, film!)]);
    await s.expectError(await s.approve(s.changeOf(pending, 0)), 409, 'invalid_tree');
    expect(await s.treeOf(ids)).toEqual(before);
    expect(await s.statusOf(s.changeOf(pending, 0))).toBe('pending');
  } finally {
    await s.t.close();
  }
});

it('merge into a work without a parent gives it the loser’s parent', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('placed', 'season'),
      work('loose', 'season'),
      partOf('show', 'placed', 4),
    ]);
    const [show, placed, loose] = [0, 1, 2].map((i) => s.idOf(made, i));
    const merged = await s.mergeLive(placed!, loose!);
    expect(await s.parentLink(loose!)).toMatchObject({ from: show, position: 4 });
    await s.revert(merged);
    expect(await s.parentLink(loose!)).toBeNull();
    expect(await s.parentLink(placed!)).toMatchObject({ from: show, position: 4 });
  } finally {
    await s.t.close();
  }
});

it('same-parent merge drops the loser’s number; unmerge restores it', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('loser', 'season'),
      work('winner', 'season'),
      partOf('show', 'loser', 3),
      partOf('show', 'winner'),
    ]);
    const [show, loser, winner] = [0, 1, 2].map((i) => s.idOf(made, i));
    const merged = await s.mergeLive(loser!, winner!);
    expect(await s.parentLink(winner!)).toMatchObject({ from: show, position: null });
    expect(await s.partsOf(show!)).toEqual([[winner, null]]);
    await s.revert(merged);
    expect(await s.parentLink(loser!)).toMatchObject({ from: show, position: 3 });
    expect(await s.parentLink(winner!)).toMatchObject({ from: show, position: null });
  } finally {
    await s.t.close();
  }
});

it('revert of a detach to a merged-away parent is 409 entity_unavailable', async () => {
  const s = await setup();
  try {
    const made = await publish(s.author, s.mod, [
      work('show', 'series'),
      work('a', 'season'),
      work('b', 'season'),
      work('ep', 'episode'),
      partOf('show', 'a', 1),
      partOf('show', 'b', 2),
      partOf('a', 'ep', 1),
    ]);
    const [a, b, ep] = [1, 2, 3].map((i) => s.idOf(made, i));
    const link = await s.parentLink(ep!);
    const detach = await publish(s.author, s.mod, [unrelate(link!.id)]);
    await s.mergeLive(a!, b!);
    await s.expectError(await s.mod.post(`/api/changes/${s.changeOf(detach, 0)}/revert`), 409, 'entity_unavailable');
    expect(await s.parentLink(ep!)).toBeNull();
  } finally {
    await s.t.close();
  }
});
