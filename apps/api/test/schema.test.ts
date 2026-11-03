import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type OpenedDb } from '../src/platform/db/open';
import { changes, entities, relations, submissions, works } from '../src/platform/db/schema';

let opened: OpenedDb;
beforeEach(async () => {
  opened = await openDb('pglite:memory');
});
afterEach(async () => {
  await opened.close();
});

const rejects = (p: Promise<unknown>) => expect(p).rejects.toThrow();

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
    );
    await opened.db
      .insert(relations)
      .values({ type: 'work_link', fromId: a!.id, toId: b!.id, linkType: 'sequel_of', createdByChange: c.id });
  });

  it('enforces the other relation-type column rules', async () => {
    const [a, b] = [await entity(), await entity()];
    const c = await change(a!.id);
    const base = { fromId: a!.id, createdByChange: c.id };
    await rejects(opened.db.insert(relations).values({ ...base, type: 'work_creator', toId: b!.id }));
    await rejects(opened.db.insert(relations).values({ ...base, type: 'series_work', toId: b!.id }));
    await rejects(opened.db.insert(relations).values({ ...base, type: 'work_tag' }));
    await rejects(opened.db.insert(relations).values({ ...base, type: 'external_id', scheme: 'imdb' }));
    await rejects(
      opened.db.insert(relations).values({ ...base, type: 'external_id', scheme: 'imdb', value: 'tt1', toId: b!.id }),
    );
    await opened.db.insert(relations).values({ ...base, type: 'work_creator', toId: b!.id, role: 'director' });
    await opened.db.insert(relations).values({ ...base, type: 'series_work', toId: b!.id, position: 1 });
    await opened.db.insert(relations).values({ ...base, type: 'external_id', scheme: 'imdb', value: 'tt1' });
  });

  it('rejects a book with a subtype, and a film_tv work without one', async () => {
    await rejects(work({ mediaType: 'book', subtype: 'movie' }));
    await rejects(work({ mediaType: 'film_tv', subtype: null }));
    await work({ mediaType: 'book', subtype: null });
  });

  it('rejects release_day without release_month, and impossible dates', async () => {
    await rejects(work({ releaseYear: 2000, releaseDay: 5 }));
    await rejects(work({ releaseMonth: 3 }));
    await rejects(work({ releaseYear: 2001, releaseMonth: 2, releaseDay: 29 }));
    await rejects(work({ releaseYear: 2000, releaseMonth: 13 }));
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
    await rejects(opened.db.insert(relations).values(row(b!.id)));
    await opened.db.update(relations).set({ removedByChange: c.id }).where(eq(relations.id, first!.id));
    await opened.db.insert(relations).values(row(b!.id));
  });

  it('requires exactly one of author_user_id and anon_hash on a submission', async () => {
    await rejects(opened.db.insert(submissions).values({}));
    await rejects(opened.db.insert(submissions).values({ anonHash: 'h', authorUserId: randomUUID() }));
    await opened.db.insert(submissions).values({ anonHash: 'h' });
  });
});

describe('works search column', () => {
  it('is generated from the normalized and original titles', async () => {
    await work({ titleNorm: 'heat', originalTitle: 'Le Samourai' });
    const hits = await opened.db
      .select({ id: works.entityId })
      .from(works)
      .where(sql`${works.search} @@ plainto_tsquery('simple', 'samourai')`);
    expect(hits).toHaveLength(1);
  });
});
