import type { EntityKind, ImportRunStatus, ImportSource } from '@amdb/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { entities, importRuns, relations } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';

export type ImportRunRow = typeof importRuns.$inferSelect;

export function importsRepository(db: DbOrTx) {
  return {
    async insertRun(run: { source: ImportSource; params: Record<string, unknown>; licenseUrl: string }) {
      const [row] = await db
        .insert(importRuns)
        .values({ ...run, status: 'running' })
        .returning({ id: importRuns.id });
      if (!row) throw new Error('import run insert returned no row');
      return row;
    },

    async finishRun(
      id: string,
      outcome: { status: Exclude<ImportRunStatus, 'running'>; stats: Record<string, unknown>; error: string | null },
    ) {
      await db
        .update(importRuns)
        .set({ ...outcome, finishedAt: new Date() })
        .where(eq(importRuns.id, id));
    },

    async getRun(id: string): Promise<ImportRunRow | null> {
      const [row] = await db.select().from(importRuns).where(eq(importRuns.id, id));
      return row ?? null;
    },

    /**
     * Who holds each QID as an active `wikidata` external id, by QID. `live` is false for a removed
     * or retracted entity, which keeps its id (a removal must stick). Read-only on the catalog.
     */
    async findByWikidataIds(qids: string[]): Promise<Map<string, { id: string; kind: EntityKind; live: boolean }>> {
      if (qids.length === 0) return new Map();
      const rows = await db
        .select({
          qid: relations.value,
          id: entities.id,
          kind: entities.kind,
          live: sql<boolean>`${entities.removedAt} IS NULL AND ${entities.retractedByChange} IS NULL`,
        })
        .from(relations)
        .innerJoin(entities, eq(entities.id, relations.fromId))
        .where(
          and(
            eq(relations.type, 'external_id'),
            eq(relations.scheme, 'wikidata'),
            inArray(relations.value, qids),
            isNull(relations.removedByChange),
          ),
        );
      // `value` is set on every external_id relation; the filter on scheme guarantees it here.
      return new Map(rows.flatMap((r) => (r.qid ? [[r.qid, { id: r.id, kind: r.kind, live: r.live }] as const] : [])));
    },

    /** The database's size on disk, as the size cap measures it. */
    async databaseBytes(): Promise<number> {
      const [row] = await db
        .select({ bytes: sql<string>`pg_database_size(current_database())::text` })
        .from(sql`(SELECT 1) AS one`);
      if (!row) throw new Error('pg_database_size returned no row');
      return Number(row.bytes);
    },
  };
}
