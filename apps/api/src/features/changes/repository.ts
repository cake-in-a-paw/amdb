import type { ChangeOp, EntityKind, MediaType } from '@amdb/shared';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  changes,
  creators,
  entities,
  properties,
  relations,
  series,
  submissions,
  tags,
  works,
} from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';
import { type Cursor, cursorBefore } from '../../platform/http/pagination';

export type Owner = { userId: string } | { anonHash: string };

export interface NewChange {
  id: string;
  seq: number;
  op: ChangeOp;
  kind: EntityKind;
  entityId: string | null;
  relationId?: string | null;
  payload: Record<string, unknown>;
  base?: Record<string, unknown> | null;
  dependsOn: string[];
}

const KIND_TABLES = { work: works, creator: creators, series, property: properties, tag: tags } as const;

const ownerCondition = (owner: Owner) =>
  'userId' in owner ? eq(submissions.authorUserId, owner.userId) : eq(submissions.anonHash, owner.anonHash);

export function changesRepository(db: DbOrTx) {
  return {
    /** A live entity (not removed or merged away) and, for a work, its media type. */
    async findEntity(id: string): Promise<{ kind: EntityKind; mediaType: MediaType | null } | null> {
      const [row] = await db
        .select({ kind: entities.kind, mediaType: works.mediaType })
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .where(and(eq(entities.id, id), isNull(entities.removedAt), isNull(entities.mergedIntoId)));
      return row ? { kind: row.kind, mediaType: row.mediaType } : null;
    },

    /** The still-pending create that reserved `id`, with who submitted it. */
    async findPendingCreate(id: string) {
      const [row] = await db
        .select({
          changeId: changes.id,
          kind: changes.kind,
          payload: changes.payload,
          authorUserId: submissions.authorUserId,
          anonHash: submissions.anonHash,
        })
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .where(and(eq(changes.entityId, id), eq(changes.op, 'create'), eq(changes.status, 'pending')));
      return row ?? null;
    },

    /** The current values of `keys` on an entity's kind table. */
    async currentFields(kind: EntityKind, id: string, keys: string[]): Promise<Record<string, unknown>> {
      const table = KIND_TABLES[kind];
      const [row] = await db.select().from(table).where(eq(table.entityId, id));
      const current: Record<string, unknown> = row ?? {};
      return Object.fromEntries(keys.filter((k) => k in current).map((k) => [k, current[k]]));
    },

    /** An active relation and the kind of entity it starts from. */
    async findActiveRelation(id: string): Promise<{ fromId: string; fromKind: EntityKind } | null> {
      const [row] = await db
        .select({ fromId: relations.fromId, fromKind: entities.kind })
        .from(relations)
        .innerJoin(entities, eq(entities.id, relations.fromId))
        .where(and(eq(relations.id, id), isNull(relations.removedByChange)));
      return row ?? null;
    },

    async insertSubmission(owner: Owner, note: string | undefined, rows: NewChange[]) {
      const [submission] = await db
        .insert(submissions)
        .values({
          authorUserId: 'userId' in owner ? owner.userId : null,
          anonHash: 'anonHash' in owner ? owner.anonHash : null,
          note: note ?? null,
        })
        .returning({ id: submissions.id });
      if (!submission) throw new Error('submission insert returned no row');
      const inserted = await db
        .insert(changes)
        .values(rows.map((r) => ({ ...r, submissionId: submission.id, status: 'pending' as const })))
        .returning({
          id: changes.id,
          seq: changes.seq,
          op: changes.op,
          status: changes.status,
          entityId: changes.entityId,
        });
      return { id: submission.id, changes: inserted.toSorted((a, b) => a.seq - b.seq) };
    },

    async getSubmission(id: string) {
      const [submission] = await db.select().from(submissions).where(eq(submissions.id, id));
      if (!submission) return null;
      const rows = await db.select().from(changes).where(eq(changes.submissionId, id)).orderBy(asc(changes.seq));
      return { submission, changes: rows };
    },

    /** Newest first; fetches `limit` + 1 so the caller can tell whether another page exists. */
    async listSubmissions(owner: Owner, cursor: Cursor | null, limit: number) {
      const subs = await db
        .select()
        .from(submissions)
        .where(and(ownerCondition(owner), cursorBefore(submissions.createdAt, submissions.id, cursor)))
        .orderBy(desc(submissions.createdAt), desc(submissions.id))
        .limit(limit + 1);
      const ids = subs.map((s) => s.id);
      const rows = ids.length
        ? await db
            .select({
              submissionId: changes.submissionId,
              id: changes.id,
              seq: changes.seq,
              op: changes.op,
              kind: changes.kind,
              status: changes.status,
            })
            .from(changes)
            .where(inArray(changes.submissionId, ids))
            .orderBy(asc(changes.seq))
        : [];
      return subs.map((s) => ({ ...s, changes: rows.filter((r) => r.submissionId === s.id) }));
    },
  };
}
