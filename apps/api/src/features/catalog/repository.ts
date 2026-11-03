import type { EntityKind } from '@amdb/shared';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { creators, entities, properties, relations, series, tags, works } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';

const KIND_TABLES = { work: works, creator: creators, series, property: properties, tag: tags } as const;

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

    /** Display fields for entities: a title (a creator's or tag's name), and for works the media type and year. */
    async summaries(ids: string[]) {
      if (!ids.length) return [];
      return db
        .select({
          id: entities.id,
          kind: entities.kind,
          title: sql<string>`coalesce(${works.title}, ${creators.name}, ${series.title}, ${properties.title}, ${tags.name})`,
          mediaType: works.mediaType,
          releaseYear: works.releaseYear,
        })
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .leftJoin(creators, eq(creators.entityId, entities.id))
        .leftJoin(series, eq(series.entityId, entities.id))
        .leftJoin(properties, eq(properties.entityId, entities.id))
        .leftJoin(tags, eq(tags.entityId, entities.id))
        .where(inArray(entities.id, ids));
    },
  };
}
