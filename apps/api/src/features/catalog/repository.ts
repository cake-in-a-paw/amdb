import type { EntityKind, MediaType } from '@amdb/shared';
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { changes, creators, entities, properties, relations, series, tags, works } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';
import type { SearchCursor } from './schemas';

/**
 * The entities the public sees in lists, relation groups, search and duplicates: not removed,
 * retracted (its create was rejected or reverted) or merged away. The one place that rule lives.
 */
export const listed = () =>
  and(isNull(entities.removedAt), isNull(entities.retractedByChange), isNull(entities.mergedIntoId));

const KIND_TABLES = { work: works, creator: creators, series, property: properties, tag: tags } as const;

/** A creator's or tag's name is its title. */
const titleExpr = sql<string>`coalesce(${works.title}, ${creators.name}, ${series.title}, ${properties.title}, ${tags.name})`;

const summaryColumns = {
  id: entities.id,
  kind: entities.kind,
  title: titleExpr,
  mediaType: works.mediaType,
  releaseYear: works.releaseYear,
};

/** Escapes `%`, `_` and `\` so user text matches literally in a `like`. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** Reads current catalog state. Writes happen only in features/changes/apply.ts. */
export function catalogRepository(db: DbOrTx) {
  return {
    async findEntity(id: string) {
      const [row] = await db.select().from(entities).where(eq(entities.id, id));
      return row ?? null;
    },

    async kindRow(kind: EntityKind, id: string): Promise<Record<string, unknown> | null> {
      const table = KIND_TABLES[kind];
      const [row] = await db.select().from(table).where(eq(table.entityId, id));
      return row ?? null;
    },

    /** Active relations starting or ending at `id`, oldest first. */
    async activeRelations(id: string) {
      return db
        .select()
        .from(relations)
        .where(and(or(eq(relations.fromId, id), eq(relations.toId, id)), isNull(relations.removedByChange)))
        .orderBy(relations.createdAt, relations.id);
    },

    /** Display fields for the listed ones among `ids`: a title (a creator's or tag's name), and for works the media type and year. */
    async summaries(ids: string[]) {
      if (!ids.length) return [];
      return db
        .select(summaryColumns)
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .leftJoin(creators, eq(creators.entityId, entities.id))
        .leftJoin(series, eq(series.entityId, entities.id))
        .leftJoin(properties, eq(properties.entityId, entities.id))
        .leftJoin(tags, eq(tags.entityId, entities.id))
        .where(and(inArray(entities.id, ids), listed()));
    },

    /**
     * Listed entities matching `norm` (a normalized query), ordered by title then id; fetches
     * `limit` + 1. Works match on every term, the last as a prefix, against `works.search`; the
     * other kinds match `like %norm%` on their normalized title or name.
     */
    async search(
      norm: string,
      filter: { kind?: EntityKind; mediaType?: MediaType },
      after: SearchCursor | null,
      limit: number,
    ) {
      const terms = norm.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (!terms.length) return [];
      const tsquery = terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(' & ');
      const pattern = `%${likeEscape(norm)}%`;
      const kind = filter.mediaType ? 'work' : filter.kind;
      return db
        .select(summaryColumns)
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .leftJoin(creators, eq(creators.entityId, entities.id))
        .leftJoin(series, eq(series.entityId, entities.id))
        .leftJoin(properties, eq(properties.entityId, entities.id))
        .leftJoin(tags, eq(tags.entityId, entities.id))
        .where(
          and(
            listed(),
            kind ? eq(entities.kind, kind) : undefined,
            filter.mediaType ? eq(works.mediaType, filter.mediaType) : undefined,
            or(
              sql`${works.search} @@ to_tsquery('simple', ${tsquery})`,
              sql`${creators.nameNorm} like ${pattern}`,
              sql`${series.titleNorm} like ${pattern}`,
              sql`${properties.titleNorm} like ${pattern}`,
              sql`${tags.nameNorm} like ${pattern}`,
            ),
            after ? sql`(${titleExpr}, ${entities.id}) > (${after.title}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(titleExpr), asc(entities.id))
        .limit(limit + 1);
    },

    /** Listed entities of `kind` (and for works, `mediaType`), ordered by title then id; fetches `limit` + 1. */
    async browse(kind: EntityKind, mediaType: MediaType | undefined, after: SearchCursor | null, limit: number) {
      return db
        .select(summaryColumns)
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .leftJoin(creators, eq(creators.entityId, entities.id))
        .leftJoin(series, eq(series.entityId, entities.id))
        .leftJoin(properties, eq(properties.entityId, entities.id))
        .leftJoin(tags, eq(tags.entityId, entities.id))
        .where(
          and(
            listed(),
            eq(entities.kind, kind),
            mediaType ? eq(works.mediaType, mediaType) : undefined,
            after ? sql`(${titleExpr}, ${entities.id}) > (${after.title}, ${after.id}::uuid)` : undefined,
          ),
        )
        .orderBy(asc(titleExpr), asc(entities.id))
        .limit(limit + 1);
    },

    /**
     * For each hub (creator, series or property) in `hubIds`, its listed works other than
     * `exceptWorkId` through active relations of `type`: ordered by release year (undated last)
     * then title, at most `perHub` per hub. Returns `{ hubId, workId }` pairs in that order.
     */
    async worksOfHubs(
      type: 'work_creator' | 'series_work' | 'property_work',
      hubIds: string[],
      exceptWorkId: string,
      perHub: number,
    ) {
      if (!hubIds.length) return [];
      // A creator is the relation's target and the work its source; for series and property, the reverse.
      const hubCol = type === 'work_creator' ? relations.toId : relations.fromId;
      const workCol = type === 'work_creator' ? relations.fromId : relations.toId;
      const ranked = db
        .select({
          hubId: sql<string>`${hubCol}`.as('hub_id'),
          workId: sql<string>`${workCol}`.as('work_id'),
          rank: sql<number>`dense_rank() over (partition by ${hubCol} order by ${works.releaseYear} asc nulls last, ${works.title} asc, ${workCol} asc)`.as(
            'rank',
          ),
        })
        .from(relations)
        .innerJoin(entities, eq(entities.id, workCol))
        .innerJoin(works, eq(works.entityId, workCol))
        .where(
          and(
            eq(relations.type, type),
            isNull(relations.removedByChange),
            inArray(hubCol, hubIds),
            ne(workCol, exceptWorkId),
            listed(),
          ),
        )
        .as('ranked');
      // Two relations (say director and writer) to one work repeat its row with the same dense rank;
      // distinct keeps the work once, and it takes one of the `perHub` slots.
      return db
        .selectDistinct({ hubId: ranked.hubId, workId: ranked.workId, rank: ranked.rank })
        .from(ranked)
        .where(lte(ranked.rank, perHub))
        .orderBy(ranked.hubId, ranked.rank);
    },

    /**
     * The duplicate check's matching, the same for existing and pending: the normalized title or
     * name contains `norm`. Listed entities, by title; fetches at most `limit`.
     */
    async existingMatching(norm: string, filter: { kind: EntityKind; mediaType?: MediaType }, limit: number) {
      const pattern = `%${likeEscape(norm)}%`;
      return db
        .select(summaryColumns)
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .leftJoin(creators, eq(creators.entityId, entities.id))
        .leftJoin(series, eq(series.entityId, entities.id))
        .leftJoin(properties, eq(properties.entityId, entities.id))
        .leftJoin(tags, eq(tags.entityId, entities.id))
        .where(
          and(
            listed(),
            eq(entities.kind, filter.kind),
            filter.mediaType ? eq(works.mediaType, filter.mediaType) : undefined,
            or(
              sql`${works.titleNorm} like ${pattern}`,
              sql`${creators.nameNorm} like ${pattern}`,
              sql`${series.titleNorm} like ${pattern}`,
              sql`${properties.titleNorm} like ${pattern}`,
              sql`${tags.nameNorm} like ${pattern}`,
            ),
          ),
        )
        .orderBy(asc(titleExpr), asc(entities.id))
        .limit(limit);
    },

    /** Pending creates whose normalized title or name contains `norm`, newest first, with only the fields the duplicate check may show. */
    async pendingMatching(norm: string, filter: { kind: EntityKind; mediaType?: MediaType }, limit: number) {
      return db
        .select({ payload: changes.payload })
        .from(changes)
        .where(
          and(
            eq(changes.op, 'create'),
            eq(changes.status, 'pending'),
            eq(changes.kind, filter.kind),
            sql`${changes.titleNorm} like ${`%${likeEscape(norm)}%`}`,
            filter.mediaType ? sql`${changes.payload}->>'mediaType' = ${filter.mediaType}` : undefined,
          ),
        )
        .orderBy(desc(changes.createdAt), desc(changes.id))
        .limit(limit);
    },
  };
}
