import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { importRuns, submissions, works } from '../src/platform/db/schema';
import { setupTest } from './helpers/setup';

const LICENSE = 'https://www.wikidata.org/wiki/Wikidata:Licensing';

const film = (ref: string, title: string) => ({
  op: 'create',
  kind: 'work',
  ref,
  fields: { mediaType: 'film_tv', subtype: 'movie', title, releaseYear: 2016 },
});
const qid = (ref: string, value: string) => ({
  op: 'relate',
  type: 'external_id',
  from: { ref },
  data: { scheme: 'wikidata', value },
});

async function setup() {
  const t = await setupTest();
  const mod = t.as({ kind: 'user', userId: await t.createUser({ role: 'moderator' }) });
  const anon = t.as({ kind: 'none' });
  return { t, mod, anon };
}

/** Asserts the promise failed on the named constraint (drizzle wraps the driver error as `cause`). */
async function rejects(p: Promise<unknown>, constraint: string) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, `expected a failure on ${constraint}`).toBeDefined();
  const messages: string[] = [];
  for (let e = err; e instanceof Error; e = e.cause) messages.push(e.message);
  expect(messages.join('\n')).toContain(`"${constraint}"`);
}

it('an imported submission is live at once, attributed to its run in public history, and absent from the queue', async () => {
  const { t, mod, anon } = await setup();
  try {
    const { runId, changes } = await t.importSubmission([film('w', 'Arrival'), qid('w', 'Q1')]);
    const id = changes[0]!.entityId!;
    expect((await anon.get(`/api/entities/${id}`)).status).toBe(200);

    const history = (await (await anon.get(`/api/entities/${id}/history`)).json()) as {
      items: { changeId: string; author: unknown; source: string }[];
    };
    expect(history.items.map((i) => i.changeId).toSorted()).toEqual(changes.map((c) => c.id).toSorted());
    for (const item of history.items) {
      expect(item.author).toEqual({ importRun: { id: runId, source: 'wikidata' } });
      expect(item.source).toBe('import');
    }

    for (const c of changes) {
      const res = await mod.get(`/api/changes/${c.id}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe('approved');
    }

    const queue = (await (await mod.get('/api/moderation/queue')).json()) as { items: unknown[] };
    expect(queue.items).toHaveLength(0);
  } finally {
    await t.close();
  }
});

it('a creator can carry a wikidata external id', async () => {
  const { t, anon } = await setup();
  try {
    const { changes } = await t.importSubmission([
      { op: 'create', kind: 'creator', ref: 'c', fields: { kind: 'person', name: 'Denis Villeneuve' } },
      qid('c', 'Q22000'),
    ]);
    const res = await anon.get(`/api/entities/${changes[0]!.entityId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { relations: { externalIds?: { scheme: string; value: string }[] } };
    expect(body.relations.externalIds).toEqual([expect.objectContaining({ scheme: 'wikidata', value: 'Q22000' })]);
  } finally {
    await t.close();
  }
});

it('a duplicate external id across imported submissions is a 409, and nothing of that submission is written', async () => {
  const { t } = await setup();
  try {
    await t.importSubmission([film('a', 'Arrival'), qid('a', 'Q1')]);
    const [before] = await t.db.select({ n: count() }).from(submissions);
    const err = await t.importSubmission([film('b', 'Sicario'), qid('b', 'Q1')]).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 409, code: 'duplicate_external_id' });
    const [after] = await t.db.select({ n: count() }).from(submissions);
    expect(after!.n).toBe(before!.n);
    expect(await t.db.select().from(works).where(eq(works.title, 'Sicario'))).toEqual([]);
  } finally {
    await t.close();
  }
});

it('a moderator can revert an imported change', async () => {
  const { t, mod, anon } = await setup();
  try {
    const { changes } = await t.importSubmission([film('w', 'Arrival'), qid('w', 'Q1')]);
    const res = await mod.post(`/api/changes/${changes[1]!.id}/revert`);
    expect(res.status, await res.clone().text()).toBe(200);
    const view = (await (await anon.get(`/api/entities/${changes[0]!.entityId}`)).json()) as {
      relations: { externalIds?: unknown[] };
    };
    expect(view.relations.externalIds).toEqual([]);
  } finally {
    await t.close();
  }
});

it('GET /api/import-runs/{id} is public and 404s for an unknown id', async () => {
  const { t, anon } = await setup();
  try {
    const { runId } = await t.importSubmission([film('w', 'Arrival')], { classes: ['Q11424'] });
    const res = await anon.get(`/api/import-runs/${runId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: runId,
      source: 'wikidata',
      status: 'running',
      params: { classes: ['Q11424'] },
      licenseUrl: LICENSE,
      stats: {},
      error: null,
      startedAt: expect.any(String),
      finishedAt: null,
    });
    expect((await anon.get(`/api/import-runs/${randomUUID()}`)).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('a submission with no author, or with two authors, violates submissions_one_author', async () => {
  const { t } = await setup();
  try {
    const userId = await t.createUser();
    const [run] = await t.db
      .insert(importRuns)
      .values({ source: 'wikidata', params: {}, licenseUrl: LICENSE, status: 'running' })
      .returning({ id: importRuns.id });
    const importRunId = run!.id;
    // The run alone is an author.
    await t.db.insert(submissions).values({ importRunId });
    await rejects(t.db.insert(submissions).values({}), 'submissions_one_author');
    await rejects(t.db.insert(submissions).values({ importRunId, authorUserId: userId }), 'submissions_one_author');
    await rejects(t.db.insert(submissions).values({ importRunId, anonHash: 'h' }), 'submissions_one_author');
    await rejects(t.db.insert(submissions).values({ authorUserId: userId, anonHash: 'h' }), 'submissions_one_author');
  } finally {
    await t.close();
  }
});
