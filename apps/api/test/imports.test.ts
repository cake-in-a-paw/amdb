import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createChangesService } from '../src/features/changes/service';
import { ChangeInput } from '../src/features/changes/schemas';
import { createImportsService } from '../src/features/imports/service';
import { importRuns, submissions, works } from '../src/platform/db/schema';
import { publish, submit } from './helpers/catalog';
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

const names = (entityId: string, alternateTitles: string[]) => ({
  op: 'update',
  kind: 'work',
  entityId,
  fields: { alternateTitles },
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
      // The helper finishes its run once the submission is in, as the importer does.
      status: 'finished',
      params: { classes: ['Q11424'] },
      licenseUrl: LICENSE,
      licenseCheckedOn: '2026-11-05',
      stats: {},
      error: null,
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
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
      .values({
        source: 'wikidata',
        params: {},
        licenseUrl: LICENSE,
        licenseCheckedOn: '2026-11-05',
        status: 'running',
      })
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

const startRun = (t: Awaited<ReturnType<typeof setupTest>>) =>
  createImportsService(t.db).startRun({
    source: 'wikidata',
    params: {},
    licenseUrl: LICENSE,
    licenseCheckedOn: '2026-11-05',
  });

it('finishing a run that already finished changes nothing', async () => {
  const { t } = await setup();
  try {
    const imports = createImportsService(t.db);
    const { id } = await startRun(t);
    await imports.finishRun(id, { status: 'finished', stats: { imported: 3 } });
    await imports.finishRun(id, { status: 'failed', stats: {}, error: 'late' });
    expect(await imports.getRun(id)).toMatchObject({ status: 'finished', stats: { imported: 3 }, error: null });
  } finally {
    await t.close();
  }
});

it('an import submission to a run that isn’t running is a 409 run_not_running; to an unknown run, a 404', async () => {
  const { t } = await setup();
  try {
    const { id } = await startRun(t);
    await createImportsService(t.db).finishRun(id, { status: 'failed', stats: {}, error: 'interrupted' });
    const changes = createChangesService(t.db);
    const input = [ChangeInput.parse(film('w', 'Arrival'))];
    await expect(changes.importSubmission(id, input)).rejects.toMatchObject({ status: 409, code: 'run_not_running' });
    await expect(changes.importSubmission(randomUUID(), input)).rejects.toMatchObject({ status: 404 });
    expect(await t.db.select().from(works)).toEqual([]);
  } finally {
    await t.close();
  }
});

it('a second running run violates import_runs_one_running', async () => {
  const { t } = await setup();
  try {
    await startRun(t);
    await rejects(
      t.db.insert(importRuns).values({
        source: 'wikidata',
        params: {},
        licenseUrl: LICENSE,
        licenseCheckedOn: '2026-11-05',
        status: 'running',
      }),
      'import_runs_one_running',
    );
  } finally {
    await t.close();
  }
});

it('a moderator reading an imported submission sees its run, and no account', async () => {
  const { t, mod } = await setup();
  try {
    const { id, runId } = await t.importSubmission([film('w', 'Arrival')]);
    const res = await mod.get(`/api/submissions/${id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, authorUserId: null, importRunId: runId });
  } finally {
    await t.close();
  }
});

describe('which name lists an import may still extend', () => {
  /** A work an import created, then named by a second import run's update (as a backfill does). */
  async function importedNamedWork(t: Awaited<ReturnType<typeof setupTest>>) {
    const { changes } = await t.importSubmission([film('w', 'Arrival'), qid('w', 'Q1')]);
    const id = changes[0]!.entityId!;
    const named = await t.importSubmission([
      { op: 'update', kind: 'work', entityId: id, fields: { alternateTitles: ['Story of Your Life'] } },
    ]);
    return { id, namesChangeId: named.changes[0]!.id };
  }
  const blocked = async (t: Awaited<ReturnType<typeof setupTest>>, id: string) =>
    (await createImportsService(t.db).findNamesBlocked([id], 'alternateTitles')).has(id);

  it('a list only import runs set is open', async () => {
    const { t } = await setup();
    try {
      const { id } = await importedNamedWork(t);
      expect(await blocked(t, id)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('a person’s names edit blocks the list, approved or still pending', async () => {
    const { t, mod } = await setup();
    try {
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const approved = await importedNamedWork(t);
      await publish(author, mod, [names(approved.id, ['Arrival (2016)'])]);
      expect(await blocked(t, approved.id)).toBe(true);

      const { changes } = await t.importSubmission([film('p', 'Sicario'), qid('p', 'Q2')]);
      const pending = changes[0]!.entityId!;
      await submit(author, [names(pending, ['Soldado'])]);
      expect(await blocked(t, pending)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('a moderator’s revert of the import’s names change blocks the list', async () => {
    const { t, mod } = await setup();
    try {
      const { id, namesChangeId } = await importedNamedWork(t);
      const res = await mod.post(`/api/changes/${namesChangeId}/revert`);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await blocked(t, id)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('a revert of a person’s title edit on the same work leaves the list open', async () => {
    const { t, mod } = await setup();
    try {
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const { id } = await importedNamedWork(t);
      const edit = await publish(author, mod, [
        { op: 'update', kind: 'work', entityId: id, fields: { title: 'Arrival!' } },
      ]);
      const res = await mod.post(`/api/changes/${edit.changes[0]!.id}/revert`);
      expect(res.status, await res.clone().text()).toBe(200);
      expect(await blocked(t, id)).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('findNameLists returns the stored list', async () => {
    const { t } = await setup();
    try {
      const { id } = await importedNamedWork(t);
      expect(await createImportsService(t.db).findNameLists('work', [id])).toEqual(
        new Map([[id, ['Story of Your Life']]]),
      );
    } finally {
      await t.close();
    }
  });

  it('assertNamesOpen passes on an unchanged list and is a 409 names_changed once a person changed it', async () => {
    const { t, mod } = await setup();
    try {
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const { id } = await importedNamedWork(t);
      const imports = createImportsService(t.db);
      const expected = [{ entityId: id, key: 'alternateTitles' as const, names: ['Story of Your Life'] }];
      await expect(imports.assertNamesOpen(expected)).resolves.toBeUndefined();
      await expect(imports.assertNamesOpen([])).resolves.toBeUndefined();

      await publish(author, mod, [names(id, ['Arrival (2016)'])]);
      await expect(imports.assertNamesOpen(expected)).rejects.toMatchObject({ status: 409, code: 'names_changed' });
      // Blocked, even when the expected list is what the person left.
      await expect(
        imports.assertNamesOpen([{ entityId: id, key: 'alternateTitles', names: ['Arrival (2016)'] }]),
      ).rejects.toMatchObject({ status: 409, code: 'names_changed' });
    } finally {
      await t.close();
    }
  });

  it('assertNamesOpen is a 409 names_changed when an open list no longer holds the expected names', async () => {
    const { t } = await setup();
    try {
      const { id } = await importedNamedWork(t);
      await expect(
        createImportsService(t.db).assertNamesOpen([{ entityId: id, key: 'alternateTitles', names: ['Other'] }]),
      ).rejects.toMatchObject({ status: 409, code: 'names_changed' });
    } finally {
      await t.close();
    }
  });

  it('an import submission checks namesOpen in its transaction and writes nothing when it fails', async () => {
    const { t, mod } = await setup();
    try {
      const author = t.as({ kind: 'user', userId: await t.createUser() });
      const { id } = await importedNamedWork(t);
      await publish(author, mod, [names(id, ['Arrival (2016)'])]);
      const imports = createImportsService(t.db);
      const { id: runId } = await startRun(t);
      const err = await createChangesService(t.db)
        .importSubmission(runId, [ChangeInput.parse(names(id, ['Arrival (2016)', 'Story of Your Life']))], {
          namesOpen: [{ entityId: id, key: 'alternateTitles', names: ['Story of Your Life'] }],
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      await imports.finishRun(runId, { status: 'finished', stats: {} });
      expect(err).toMatchObject({ status: 409, code: 'names_changed' });
      expect(await imports.findNameLists('work', [id])).toEqual(new Map([[id, ['Arrival (2016)']]]));
      expect(await t.db.select().from(submissions).where(eq(submissions.importRunId, runId))).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
