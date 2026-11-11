import type { CreatorKind, EntityKind, IdScheme, ImportRunStatus, ImportSource, RelationType } from '@amdb/shared';
import { and, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { listed } from '../../platform/db/listed';
import {
  changes,
  creators,
  entities,
  importRuns,
  properties,
  relations,
  series,
  submissions,
} from '../../platform/db/schema';
import { resolveWinner } from '../../platform/db/merge';
import type { DbOrTx } from '../../platform/db/types';

export type ImportRunRow = typeof importRuns.$inferSelect;

export function importsRepository(db: DbOrTx) {
  /**
   * Of `qids`, the live, unmerged entities of `kind` an import run created holding that QID, by QID:
   * the entity's `create` and its live wikidata id were written by the same import-run submission. One
   * a person entered (an adopted creator among them) fails the first test; a merge winner holding a
   * loser's QID fails the second.
   */
  async function importedOfKind(kind: 'work' | 'creator', qids: string[]): Promise<Map<string, string>> {
    if (qids.length === 0) return new Map();
    const idChange = alias(changes, 'id_change');
    const createChange = alias(changes, 'create_change');
    const rows = await db
      .select({ qid: relations.value, id: entities.id })
      .from(relations)
      .innerJoin(entities, eq(entities.id, relations.fromId))
      .innerJoin(idChange, eq(idChange.id, relations.createdByChange))
      .innerJoin(
        createChange,
        and(
          eq(createChange.entityId, entities.id),
          eq(createChange.op, 'create'),
          eq(createChange.submissionId, idChange.submissionId),
        ),
      )
      .innerJoin(submissions, eq(submissions.id, createChange.submissionId))
      .where(
        and(
          eq(relations.type, 'external_id'),
          eq(relations.scheme, 'wikidata'),
          inArray(relations.value, qids),
          isNull(relations.removedByChange),
          eq(entities.kind, kind),
          isNull(entities.mergedIntoId),
          isNull(entities.removedAt),
          isNull(entities.retractedByChange),
          isNotNull(submissions.importRunId),
        ),
      );
    // `value` is set on every external_id relation; the filter on scheme guarantees it here.
    return new Map(rows.flatMap((r) => (r.qid ? [[r.qid, r.id] as const] : [])));
  }

  return {
    async insertRun(run: {
      source: ImportSource;
      params: Record<string, unknown>;
      licenseUrl: string;
      licenseCheckedOn: string;
    }) {
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
        // A finished run's outcome stands; finishing it again is a no-op.
        .where(and(eq(importRuns.id, id), eq(importRuns.status, 'running')));
    },

    async findRunning(): Promise<{ id: string } | null> {
      const [row] = await db.select({ id: importRuns.id }).from(importRuns).where(eq(importRuns.status, 'running'));
      return row ?? null;
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
          // A merged loser stays live: planning resolves it to its winner.
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

    /**
     * The QIDs among `qids` that a retracted or removed entity once held on an external id that has
     * since been removed: a moderator reverted the work or reference (its id, then its create). Read-only.
     */
    async findRetiredWikidataIds(qids: string[]): Promise<Set<string>> {
      if (qids.length === 0) return new Set();
      const rows = await db
        .selectDistinct({ qid: relations.value })
        .from(relations)
        .innerJoin(entities, eq(entities.id, relations.fromId))
        .where(
          and(
            eq(relations.type, 'external_id'),
            eq(relations.scheme, 'wikidata'),
            inArray(relations.value, qids),
            isNotNull(relations.removedByChange),
            or(isNotNull(entities.removedAt), isNotNull(entities.retractedByChange)),
          ),
        );
      return new Set(rows.flatMap((r) => (r.qid ? [r.qid] : [])));
    },

    /** Of `qids`, the works an import run created that still hold that QID, by QID (`importedOfKind`). Read-only. */
    async findImportedWorks(qids: string[]): Promise<Map<string, string>> {
      return importedOfKind('work', qids);
    },

    /** Of `qids`, the creators an import run created that still hold that QID, by QID (`importedOfKind`). Read-only. */
    async findImportedCreators(qids: string[]): Promise<Map<string, string>> {
      return importedOfKind('creator', qids);
    },

    /**
     * The ids among `entityIds` whose name list a change ever touched: a create or update of any status
     * (pending, rejected and reverted ones included) whose payload has `key`, a redacted create or update
     * (its payload is gone, so it may have), or a merge into the entity. Read-only.
     */
    async findNamesTouched(entityIds: string[], key: 'alternateTitles' | 'alternateNames'): Promise<Set<string>> {
      if (entityIds.length === 0) return new Set();
      const edits = await db
        .selectDistinct({ id: changes.entityId })
        .from(changes)
        .where(
          and(
            inArray(changes.entityId, entityIds),
            inArray(changes.op, ['create', 'update']),
            or(sql`${changes.payload} ? ${key}`, isNotNull(changes.redactedAt)),
          ),
        );
      // `into` may have resolved further when the merge applied; the inverse holds where it went.
      const merges = await db
        .selectDistinct({
          payloadInto: sql<string | null>`${changes.payload}->>'into'`,
          inverseInto: sql<string | null>`${changes.inverse}->>'into'`,
        })
        .from(changes)
        .where(
          and(
            eq(changes.op, 'merge'),
            or(
              inArray(sql`${changes.payload}->>'into'`, entityIds),
              inArray(sql`${changes.inverse}->>'into'`, entityIds),
            ),
          ),
        );
      const wanted = new Set(entityIds);
      return new Set(
        [...edits.map((r) => r.id), ...merges.flatMap((r) => [r.payloadInto, r.inverseInto])].filter(
          (id): id is string => id !== null && wanted.has(id),
        ),
      );
    },

    /**
     * Every relation between entities touching `entityIds` (external ids aside), live or removed: an
     * unrelate only sets `removed_by_change`, so a removed row is how a removal is remembered. A merge
     * repoints only live rows, so a row whose end has since merged away also comes back with that end
     * resolved to its winner: the removal then still blocks the same relation to the winner. Read-only.
     */
    async findRelationKeys(
      entityIds: string[],
    ): Promise<
      { type: RelationType; fromId: string; toId: string | null; role: string | null; linkType: string | null }[]
    > {
      if (entityIds.length === 0) return [];
      const rows = await db
        .selectDistinct({
          type: relations.type,
          fromId: relations.fromId,
          toId: relations.toId,
          role: relations.role,
          linkType: relations.linkType,
        })
        .from(relations)
        .where(
          and(
            ne(relations.type, 'external_id'),
            or(inArray(relations.fromId, entityIds), inArray(relations.toId, entityIds)),
          ),
        );
      const ends = [...new Set(rows.flatMap((r) => (r.toId ? [r.fromId, r.toId] : [r.fromId])))];
      const merged = ends.length
        ? await db
            .select({ id: entities.id })
            .from(entities)
            .where(and(inArray(entities.id, ends), isNotNull(entities.mergedIntoId)))
        : [];
      if (merged.length === 0) return rows;
      const winners = new Map<string, string>();
      for (const { id } of merged) winners.set(id, await resolveWinner(db, id));
      const resolved = rows.flatMap((r) => {
        const fromId = winners.get(r.fromId) ?? r.fromId;
        const toId = (r.toId && winners.get(r.toId)) ?? r.toId;
        return fromId === r.fromId && toId === r.toId ? [] : [{ ...r, fromId, toId }];
      });
      return [...rows, ...resolved];
    },

    /**
     * The QIDs among `qids` that some entity's wikidata id once held and a moderator removed: a run
     * never gives such a QID to a hand-entered entry, wherever that removed id now sits (a merge leaves
     * removed rows on the merged-away entity). Read-only.
     */
    async findRemovedWikidataIds(qids: string[]): Promise<Set<string>> {
      if (qids.length === 0) return new Set();
      const rows = await db
        .selectDistinct({ qid: relations.value })
        .from(relations)
        .where(
          and(
            eq(relations.type, 'external_id'),
            eq(relations.scheme, 'wikidata'),
            inArray(relations.value, qids),
            isNotNull(relations.removedByChange),
          ),
        );
      return new Set(rows.flatMap((r) => (r.qid ? [r.qid] : [])));
    },

    /**
     * Hand-entered references a run may adopt: listed creators, series or properties of `kind` whose
     * normalized name is in `norms` and that hold no wikidata id and never did (so a moderator's
     * removal of one sticks). Every match, so the caller can tell one from several. Read-only.
     */
    async findUnlinkedByName(
      kind: 'creator' | 'series' | 'property',
      norms: string[],
    ): Promise<{ id: string; norm: string; creatorKind: CreatorKind | null }[]> {
      if (norms.length === 0) return [];
      const neverHadWikidata = notExists(
        db
          .select({ one: sql`1` })
          .from(relations)
          .where(
            and(eq(relations.fromId, entities.id), eq(relations.type, 'external_id'), eq(relations.scheme, 'wikidata')),
          ),
      );
      if (kind === 'creator')
        return db
          .select({ id: entities.id, norm: creators.nameNorm, creatorKind: creators.kind })
          .from(creators)
          .innerJoin(entities, eq(entities.id, creators.entityId))
          .where(and(inArray(creators.nameNorm, norms), listed(), neverHadWikidata));
      const table = kind === 'series' ? series : properties;
      return db
        .select({ id: entities.id, norm: table.titleNorm, creatorKind: sql<null>`null` })
        .from(table)
        .innerJoin(entities, eq(entities.id, table.entityId))
        .where(and(inArray(table.titleNorm, norms), listed(), neverHadWikidata));
    },

    /** Per work, every scheme of an `external_id` relation from it, live or removed (a removal must stick). */
    async findExternalIdSchemes(workIds: string[]): Promise<{ fromId: string; scheme: IdScheme }[]> {
      if (workIds.length === 0) return [];
      const rows = await db
        .selectDistinct({ fromId: relations.fromId, scheme: relations.scheme })
        .from(relations)
        .where(and(eq(relations.type, 'external_id'), inArray(relations.fromId, workIds)));
      return rows.flatMap((r) => (r.scheme ? [{ fromId: r.fromId, scheme: r.scheme }] : []));
    },

    /** The given (scheme, value) pairs that a live `external_id` relation on any entity holds. */
    async findHeldExternalIds(
      ids: { scheme: IdScheme; value: string }[],
    ): Promise<{ scheme: IdScheme; value: string }[]> {
      if (ids.length === 0) return [];
      const rows = await db
        .select({ scheme: relations.scheme, value: relations.value })
        .from(relations)
        .where(
          and(
            eq(relations.type, 'external_id'),
            isNull(relations.removedByChange),
            or(...ids.map((i) => and(eq(relations.scheme, i.scheme), eq(relations.value, i.value)))),
          ),
        );
      return rows.flatMap((r) => (r.scheme && r.value ? [{ scheme: r.scheme, value: r.value }] : []));
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
