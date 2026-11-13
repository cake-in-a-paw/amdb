import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OpenedDb } from '../src/platform/db/open';
import { changes, entities, relations, submissions, users, works } from '../src/platform/db/schema';
import { openTestDb } from './helpers/test-db';

let opened: OpenedDb;
beforeEach(async () => {
  opened = await openTestDb();
});
afterEach(async () => {
  await opened.close();
});

/** Asserts the insert failed on the named constraint or index (drizzle wraps the driver error as `cause`). */
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

async function entity(kind: 'work' | 'tag' = 'work') {
  const [e] = await opened.db.insert(entities).values({ kind }).returning();
  return e!;
}
async function change(entityId: string) {
  const [s] = await opened.db.insert(submissions).values({ anonHash: 'h' }).returning();
  const [c] = await opened.db
    .insert(changes)
    .values({ submissionId: s!.id, seq: 0, op: 'create', kind: 'work', entityId, payload: {}, status: 'published' })
    .returning();
  return c!;
}
async function work(values: Partial<typeof works.$inferInsert> = {}) {
  const e = await entity();
  return opened.db
    .insert(works)
    .values({ entityId: e.id, mediaType: 'film_tv', subtype: 'movie', title: 'Heat', titleNorm: 'heat', ...values });
}

describe('schema constraints', () => {
  it('rejects a work_link relation without link_type', async () => {
    const [a, b] = [await entity(), await entity()];
    const c = await change(a!.id);
    await rejects(
      opened.db.insert(relations).values({ type: 'work_link', fromId: a!.id, toId: b!.id, createdByChange: c.id }),
      'relations_type_columns',
    );
    await opened.db
      .insert(relations)
      .values({ type: 'work_link', fromId: a!.id, toId: b!.id, linkType: 'sequel_of', createdByChange: c.id });
  });

  it('enforces the other relation-type column rules', async () => {
    const [a, b] = [await entity(), await entity()];
    const c = await change(a!.id);
    const base = { fromId: a!.id, createdByChange: c.id };
    await rejects(
      opened.db.insert(relations).values({ ...base, type: 'work_creator', toId: b!.id }),
      'relations_type_columns',
    );
    await rejects(
      opened.db.insert(relations).values({ ...base, type: 'series_work', toId: b!.id }),
      'relations_type_columns',
    );
    await rejects(opened.db.insert(relations).values({ ...base, type: 'work_tag' }), 'relations_type_columns');
    await rejects(
      opened.db.insert(relations).values({ ...base, type: 'external_id', scheme: 'imdb' }),
      'relations_type_columns',
    );
    await rejects(
      opened.db.insert(relations).values({ ...base, type: 'external_id', scheme: 'imdb', value: 'tt1', toId: b!.id }),
      'relations_type_columns',
    );
    await opened.db.insert(relations).values({ ...base, type: 'work_creator', toId: b!.id, role: 'director' });
    await opened.db.insert(relations).values({ ...base, type: 'series_work', toId: b!.id, position: 1 });
    await opened.db.insert(relations).values({ ...base, type: 'external_id', scheme: 'imdb', value: 'tt1' });
  });

  it('rejects a book with a subtype, and a film_tv work without one', async () => {
    await rejects(work({ mediaType: 'book', subtype: 'movie' }), 'works_subtype');
    await rejects(work({ mediaType: 'film_tv', subtype: null }), 'works_subtype');
    await work({ mediaType: 'book', subtype: null });
  });

  it('rejects release_day without release_month, and impossible dates', async () => {
    await rejects(work({ releaseYear: 2000, releaseDay: 5 }), 'works_release_day_needs_month');
    await rejects(work({ releaseMonth: 3 }), 'works_release_month_needs_year');
    await rejects(work({ releaseYear: 2001, releaseMonth: 2, releaseDay: 29 }), 'works_release_day_valid');
    await rejects(work({ releaseYear: 2000, releaseMonth: 13 }), 'works_release_month_range');
    await work({ releaseYear: 2000, releaseMonth: 2, releaseDay: 29 });
  });

  it('rejects two active external_id rows with the same scheme and value, but allows one after the first is removed', async () => {
    const [a, b] = [await entity(), await entity()];
    const c = await change(a!.id);
    const row = (from: string) => ({
      type: 'external_id' as const,
      fromId: from,
      scheme: 'wikidata' as const,
      value: 'Q1',
      createdByChange: c.id,
    });
    const [first] = await opened.db.insert(relations).values(row(a!.id)).returning();
    await rejects(opened.db.insert(relations).values(row(b!.id)), 'relations_external_id_key');
    await opened.db.update(relations).set({ removedByChange: c.id }).where(eq(relations.id, first!.id));
    await opened.db.insert(relations).values(row(b!.id));
  });

  it('requires exactly one of author_user_id and anon_hash on a submission', async () => {
    const [u] = await opened.db
      .insert(users)
      .values({ email: `${randomUUID()}@example.com`, name: 'U' })
      .returning();
    await rejects(opened.db.insert(submissions).values({}), 'submissions_one_author');
    await rejects(
      opened.db.insert(submissions).values({ anonHash: 'h', authorUserId: u!.id }),
      'submissions_one_author',
    );
    await opened.db.insert(submissions).values({ authorUserId: u!.id });
    await opened.db.insert(submissions).values({ anonHash: 'h' });
  });
});

describe('work_part relations', () => {
  async function part(from: string, to: string | null, position?: number) {
    const c = await change(from);
    return {
      row: { type: 'work_part' as const, fromId: from, toId: to, position, createdByChange: c.id },
      change: c,
    };
  }

  it('allows one live parent per child, until it is retired', async () => {
    const [show, other, child] = [await entity(), await entity(), await entity()];
    const first = await part(show.id, child.id);
    const [kept] = await opened.db.insert(relations).values(first.row).returning();
    await rejects(opened.db.insert(relations).values((await part(other.id, child.id)).row), 'relations_one_parent');
    await opened.db.update(relations).set({ removedByChange: first.change.id }).where(eq(relations.id, kept!.id));
    await opened.db.insert(relations).values((await part(other.id, child.id)).row);
  });

  it('requires a to_id', async () => {
    const show = await entity();
    await rejects(opened.db.insert(relations).values((await part(show.id, null)).row), 'relations_type_columns');
  });

  it('leaves position optional and accepts 0', async () => {
    const show = await entity();
    await opened.db.insert(relations).values((await part(show.id, (await entity()).id)).row);
    await opened.db.insert(relations).values((await part(show.id, (await entity()).id, 0)).row);
  });
});

describe('works search column', () => {
  it('is generated from the normalized and original titles', async () => {
    await work({ titleNorm: 'heat', originalTitle: 'Le Samouraï', originalTitleNorm: 'le samourai' });
    const hits = await opened.db
      .select({ id: works.entityId })
      .from(works)
      .where(sql`${works.search} @@ plainto_tsquery('simple', 'samourai')`);
    expect(hits).toHaveLength(1);
  });
});
