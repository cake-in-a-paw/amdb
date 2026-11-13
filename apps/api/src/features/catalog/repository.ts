import { PART_SUBTYPES, ZERO_LAST_SUBTYPES, type EntityKind, type MediaType, type Subtype } from '@amdb/shared';
import { and, asc, count, desc, eq, inArray, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { changes, creators, entities, properties, relations, series, tags, works } from '../../platform/db/schema';
import { listed } from '../../platform/db/listed';
import type { DbOrTx } from '../../platform/db/types';
import type { PartsCursor, SearchCursor } from './schemas';

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

/** Not a part: any row but a work whose subtype is a part subtype, attached or not. Non-work rows have a null subtype. */
const notAPart = () => or(isNull(works.subtype), notInArray(works.subtype, [...PART_SUBTYPES]));

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

    /**
     * Active relations starting or ending at `id`, oldest first, except `work_part`: a work's parts
     * are paged by `parts`, and its own parent link comes from `parentLinks`.
     */
    async activeRelations(id: string) {
      return db
        .select()
        .from(relations)
        .where(
          and(
            or(eq(relations.fromId, id), eq(relations.toId, id)),
            ne(relations.type, 'work_part'),
            isNull(relations.removedByChange),
          ),
        )
        .orderBy(relations.createdAt, relations.id);
    },

    /** The live parent link of each of `childIds` that has one, whatever state the parent is in. */
    async parentLinks(childIds: string[]) {
      if (!childIds.length) return [];
      const rows = await db
        .select({
          childId: relations.toId,
          relationId: relations.id,
          parentId: relations.fromId,
          position: relations.position,
        })
        .from(relations)
        .where(
          and(eq(relations.type, 'work_part'), inArray(relations.toId, childIds), isNull(relations.removedByChange)),
        );
      // Matched on `to_id`, so every row has a child; flatMap only narrows the type.
      return rows.flatMap((r) => (r.childId ? [{ ...r, childId: r.childId }] : []));
    },

    /**
     * A creator's credits grouped by root work: one row per root, ordered by the root's earliest
     * credit (`created_at`, then id). A credit is a live `work_creator` to a listed work; its root
     * is the top of the work's live `work_part` chain, climbed at most `maxDepth` levels whatever
     * state each parent is in, so a removed show still gathers its listed parts. `parts` counts
     * the credited works under the root, other than the root itself, by subtype.
     */
    async creditRoots(creatorId: string, maxDepth: number) {
      const result = await db.execute(sql`
        with recursive credit as (
          select r.from_id as work_id, r.role, row_number() over (order by r.created_at, r.id) as ord
          from ${relations} r
          join ${entities} on ${entities.id} = r.from_id
          where r.type = 'work_creator' and r.to_id = ${creatorId} and r.removed_by_change is null and ${listed()}
        ),
        climb(work_id, node_id, depth) as (
          select distinct work_id, work_id, 0 from credit
          union all
          select c.work_id, p.from_id, c.depth + 1
          from climb c
          join ${relations} p on p.type = 'work_part' and p.to_id = c.node_id and p.removed_by_change is null
          where c.depth < ${maxDepth}
        ),
        root as (
          select distinct on (work_id) work_id, node_id as root_id from climb order by work_id, depth desc
        ),
        rooted as (
          select root.root_id, credit.work_id, credit.role, credit.ord
          from credit join root on root.work_id = credit.work_id
        )
        select
          g.root_id as "rootId",
          exists (select 1 from ${entities} where ${entities.id} = g.root_id and ${listed()}) as "rootListed",
          array_agg(distinct g.role) as roles,
          coalesce(
            (select json_agg(json_build_object('subtype', x.subtype, 'n', x.n))
             from (
               select w.subtype, count(distinct p.work_id) as n
               from rooted p join ${works} w on w.entity_id = p.work_id
               where p.root_id = g.root_id and p.work_id <> p.root_id and w.subtype is not null
               group by w.subtype
             ) x),
            '[]'::json
          ) as parts
        from rooted g
        group by g.root_id
        order by min(g.ord)
      `);
      // `execute` returns the driver's raw result; both PGlite and node-postgres put rows in `rows`,
      // with these aliased columns. Counts sit inside JSON, so they arrive as numbers on both.
      return (
        result as unknown as {
          rows: { rootId: string; rootListed: boolean; roles: string[]; parts: { subtype: Subtype; n: number }[] }[];
        }
      ).rows;
    },

    /** Display fields for the works among `ids`, listed or not; `removed` once taken down. */
    async workRows(ids: string[]) {
      if (!ids.length) return [];
      return db
        .select({
          id: works.entityId,
          title: works.title,
          subtype: works.subtype,
          mediaType: works.mediaType,
          releaseYear: works.releaseYear,
          removed: sql<boolean>`${entities.removedAt} IS NOT NULL`,
        })
        .from(works)
        .innerJoin(entities, eq(entities.id, works.entityId))
        .where(inArray(works.entityId, ids));
    },

    /**
     * The listed parts of `parentId` through live `work_part` rows, after `after`: numbered ones by
     * number, then unnumbered ones, then a zero-last subtype numbered 0; ties by release date, title
     * and id. Fetches `limit` + 1, each with its cursor key.
     */
    async parts(parentId: string, after: PartsCursor | null, limit: number) {
      const b = sql<number>`(CASE WHEN ${relations.position} IS NULL THEN 1
        WHEN ${relations.position} = 0 AND ${inArray(works.subtype, [...ZERO_LAST_SUBTYPES])} THEN 2 ELSE 0 END)`;
      const p = sql<number>`coalesce(${relations.position}, 0)`;
      const y = sql<number>`coalesce(${works.releaseYear}, 10000)`;
      const m = sql<number>`coalesce(${works.releaseMonth}, 13)`;
      const d = sql<number>`coalesce(${works.releaseDay}, 32)`;
      return db
        .select({
          relationId: relations.id,
          position: relations.position,
          id: works.entityId,
          title: works.title,
          subtype: works.subtype,
          mediaType: works.mediaType,
          releaseYear: works.releaseYear,
          b,
          p,
          y,
          m,
          d,
        })
        .from(relations)
        .innerJoin(works, eq(works.entityId, relations.toId))
        .innerJoin(entities, eq(entities.id, relations.toId))
        .where(
          and(
            eq(relations.type, 'work_part'),
            eq(relations.fromId, parentId),
            isNull(relations.removedByChange),
            listed(),
            after
              ? sql`(${b}, ${p}, ${y}, ${m}, ${d}, ${works.title}, ${works.entityId}) > (${after.b}, ${after.p}, ${after.y}, ${after.m}, ${after.d}, ${after.t}, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(b), asc(p), asc(y), asc(m), asc(d), asc(works.title), asc(works.entityId))
        .limit(limit + 1);
    },

    /** How many listed parts `parentId` has through live `work_part` rows. */
    async partCount(parentId: string): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(relations)
        .innerJoin(entities, eq(entities.id, relations.toId))
        .where(
          and(
            eq(relations.type, 'work_part'),
            eq(relations.fromId, parentId),
            isNull(relations.removedByChange),
            listed(),
          ),
        );
      return row?.n ?? 0;
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
     * Listed entities matching `norm` (a normalized query), ordered by rank, title, then id;
     * fetches `limit` + 1. Works match on every term, the last as a prefix, against `works.search`
     * or `works.alt_search`; the other kinds match `like %norm%` on their normalized title or name
     * (creators also on alternate names). Rank is 1 for a row matched only through alternate
     * names, else 0. Parts are left out unless `includeParts`. Each row carries its work subtype.
     */
    async search(
      norm: string,
      filter: { kind?: EntityKind; mediaType?: MediaType; includeParts: boolean },
      after: SearchCursor | null,
      limit: number,
    ) {
      const terms = norm.match(/[\p{L}\p{N}]+/gu) ?? [];
      if (!terms.length) return [];
      const tsquery = terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(' & ');
      const pattern = `%${likeEscape(norm)}%`;
      const kind = filter.mediaType ? 'work' : filter.kind;
      const mainMatch = or(
        sql`${works.search} @@ to_tsquery('simple', ${tsquery})`,
        sql`${creators.nameNorm} like ${pattern}`,
        sql`${series.titleNorm} like ${pattern}`,
        sql`${properties.titleNorm} like ${pattern}`,
        sql`${tags.nameNorm} like ${pattern}`,
      );
      const altMatch = or(
        sql`${works.altSearch} @@ to_tsquery('simple', ${tsquery})`,
        sql`${creators.alternateNamesNorm} like ${pattern}`,
      );
      // 1 when the row matched only through alternate names, so those sort after every main match.
      // A `case` treats a null condition (a kind without the column) as false.
      const rankExpr = sql<number>`(case when ${mainMatch} then 0 when ${altMatch} then 1 else 0 end)`;
      return db
        .select({ ...summaryColumns, subtype: works.subtype, rank: rankExpr })
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
            filter.includeParts ? undefined : notAPart(),
            or(mainMatch, altMatch),
            after
              ? sql`(${rankExpr}, ${titleExpr}, ${entities.id}) > (${after.rank}, ${after.title}, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(rankExpr), asc(titleExpr), asc(entities.id))
        .limit(limit + 1);
    },

    /** Listed entities of `kind` (and for works, `mediaType`) other than parts, ordered by title then id; fetches `limit` + 1. */
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
            notAPart(),
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
            // No part fills a related group, attached or not.
            notAPart(),
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
     * The duplicate check's matching, the same for existing and pending: the normalized title,
     * name or alternate name contains `norm`. Listed entities, by title; fetches at most `limit`.
     * With `parentId`, only that work's parts through live `work_part` rows; without it, no parts.
     */
    async existingMatching(
      norm: string,
      filter: { kind: EntityKind; mediaType?: MediaType; parentId?: string },
      limit: number,
    ) {
      const pattern = `%${likeEscape(norm)}%`;
      const partsOfParent = (parentId: string) =>
        db
          .select({ id: relations.toId })
          .from(relations)
          .where(
            and(eq(relations.type, 'work_part'), eq(relations.fromId, parentId), isNull(relations.removedByChange)),
          );
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
            filter.parentId ? inArray(entities.id, partsOfParent(filter.parentId)) : notAPart(),
            or(
              sql`${works.titleNorm} like ${pattern}`,
              sql`${works.alternateTitlesNorm} like ${pattern}`,
              sql`${creators.nameNorm} like ${pattern}`,
              sql`${creators.alternateNamesNorm} like ${pattern}`,
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
