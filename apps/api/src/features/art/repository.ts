import type { IdScheme } from '@amdb/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { listed } from '../../platform/db/listed';
import { resolveWinner } from '../../platform/db/merge';
import { entities, relations } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';

/** Reads which works the public can see and the ids they hold. Never writes. */
export function artRepository(db: DbOrTx) {
  return {
    /**
     * Each requested id mapped to the live work that holds its data: itself, or its merge winner.
     * An id that is unknown, removed (even when merged away first, as entity reads treat it),
     * retracted, or not a work is left out. Live means what the catalog lists: not removed,
     * retracted or merged away.
     */
    async liveWorks(ids: string[]): Promise<Map<string, string>> {
      const out = new Map<string, string>();
      if (ids.length === 0) return out;
      const rows = await db
        .select({ id: entities.id, removedAt: entities.removedAt, mergedIntoId: entities.mergedIntoId })
        .from(entities)
        .where(inArray(entities.id, ids));
      const candidates = new Map<string, string>();
      for (const row of rows) {
        if (row.removedAt) continue;
        candidates.set(row.id, row.mergedIntoId ? await resolveWinner(db, row.id) : row.id);
      }
      const winners = [...new Set(candidates.values())];
      if (winners.length === 0) return out;
      const live = new Set(
        (
          await db
            .select({ id: entities.id })
            .from(entities)
            .where(and(inArray(entities.id, winners), eq(entities.kind, 'work'), listed()))
        ).map((r) => r.id),
      );
      for (const [id, winner] of candidates) if (live.has(winner)) out.set(id, winner);
      return out;
    },

    /** The live external ids of `schemes` each work holds, in a stable order (scheme, then value). */
    async externalIds(workIds: string[], schemes: readonly IdScheme[]) {
      if (workIds.length === 0 || schemes.length === 0) return [];
      const rows = await db
        .select({ workId: relations.fromId, scheme: relations.scheme, value: relations.value })
        .from(relations)
        .where(
          and(
            eq(relations.type, 'external_id'),
            isNull(relations.removedByChange),
            inArray(relations.fromId, workIds),
            inArray(relations.scheme, [...schemes]),
          ),
        )
        .orderBy(asc(relations.scheme), asc(relations.value));
      return rows.flatMap((r) => (r.scheme && r.value ? [{ workId: r.workId, scheme: r.scheme, value: r.value }] : []));
    },
  };
}
