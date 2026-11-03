import type { ChangeOp, EntityKind, MediaType } from '@amdb/shared';
import { and, arrayContains, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
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

export type ChangeRow = typeof changes.$inferSelect;
export type ChangePatch = Partial<Omit<ChangeRow, 'id' | 'submissionId' | 'seq' | 'createdAt'>>;

/** The moderation queue's sort key: oldest submission first, then its changes in order. */
export interface QueueKey {
  createdAt: string;
  submissionId: string;
  seq: number;
}

/** The history sort key: newest applied first, then submission order, then id. */
export interface HistoryKey {
  appliedAt: string;
  seq: number;
  id: string;
}

export type Owner = { userId: string } | { anonHash: string };

export interface NewChange {
  id: string;
  seq: number;
  op: ChangeOp;
  kind: EntityKind;
  entityId: string | null;
  relationId?: string | null;
  payload: Record<string, unknown>;
  /** A create's normalized title or name. */
  titleNorm?: string | null;
  base?: Record<string, unknown> | null;
  dependsOn: string[];
  resubmitOf?: string | null;
}

const KIND_TABLES = { work: works, creator: creators, series, property: properties, tag: tags } as const;

const ownerCondition = (owner: Owner) =>
  'userId' in owner ? eq(submissions.authorUserId, owner.userId) : eq(submissions.anonHash, owner.anonHash);

export function changesRepository(db: DbOrTx) {
  return {
    /** A live entity (not removed, retracted or merged away) and, for a work, its media type. */
    async findEntity(id: string): Promise<{ kind: EntityKind; mediaType: MediaType | null } | null> {
      const [row] = await db
        .select({ kind: entities.kind, mediaType: works.mediaType })
        .from(entities)
        .leftJoin(works, eq(works.entityId, entities.id))
        .where(
          and(
            eq(entities.id, id),
            isNull(entities.removedAt),
            isNull(entities.retractedByChange),
            isNull(entities.mergedIntoId),
          ),
        );
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

    /** The change, locked until the transaction ends. */
    async lockChange(id: string): Promise<ChangeRow | null> {
      const [row] = await db.select().from(changes).where(eq(changes.id, id)).for('update');
      return row ?? null;
    },

    /** The statuses of `ids`, share-locked so a concurrent reject waits for this transaction. */
    async lockStatuses(ids: string[]) {
      if (!ids.length) return [];
      return db
        .select({ id: changes.id, status: changes.status })
        .from(changes)
        .where(inArray(changes.id, ids))
        .for('share');
    },

    async updateChange(id: string, patch: ChangePatch) {
      await db.update(changes).set(patch).where(eq(changes.id, id));
    },

    /** Rejects the still-pending changes that depend on `id`; returns their ids. */
    async rejectPendingDependents(id: string, patch: ChangePatch) {
      const rows = await db
        .update(changes)
        .set({ ...patch, status: 'rejected' })
        .where(and(eq(changes.status, 'pending'), arrayContains(changes.dependsOn, [id])))
        .returning({ id: changes.id });
      return rows.map((r) => r.id);
    },

    /** A change with who submitted it. */
    async getChangeWithAuthor(id: string) {
      const [row] = await db
        .select({ change: changes, authorUserId: submissions.authorUserId, anonHash: submissions.anonHash })
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .where(eq(changes.id, id));
      return row ?? null;
    },

    async findResubmission(id: string) {
      const [row] = await db.select({ id: changes.id }).from(changes).where(eq(changes.resubmitOf, id));
      return row ?? null;
    },

    /**
     * Approved and published changes that touched the entity (as a target, or through a relation
     * it is an end of), newest first; fetches `limit` + 1.
     */
    async history(entityId: string, after: HistoryKey | null, limit: number) {
      return db
        .select({ change: changes, authorUserId: submissions.authorUserId })
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .where(
          and(
            inArray(changes.status, ['approved', 'published']),
            or(
              eq(changes.entityId, entityId),
              sql`${changes.relationId} in (select ${relations.id} from ${relations} where ${relations.fromId} = ${entityId} or ${relations.toId} = ${entityId})`,
            ),
            after
              ? sql`(${changes.appliedAt}, ${changes.seq}, ${changes.id}) < (${after.appliedAt}::timestamptz, ${after.seq}::int, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(changes.appliedAt), desc(changes.seq), desc(changes.id))
        .limit(limit + 1);
    },

    /** The live revert of `id`, if any. */
    async findRevert(id: string) {
      const [row] = await db
        .select({ id: changes.id })
        .from(changes)
        .where(and(sql`${changes.payload}->>'revertOf' = ${id}`, inArray(changes.status, ['approved', 'published'])));
      return row ?? null;
    },

    /** Pending and published changes, oldest first and in submission order; fetches `limit` + 1. */
    async queue(after: QueueKey | null, limit: number) {
      return db
        .select({ change: changes, authorUserId: submissions.authorUserId })
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .where(
          and(
            inArray(changes.status, ['pending', 'published']),
            after
              ? sql`(${changes.createdAt}, ${changes.submissionId}, ${changes.seq}) > (${after.createdAt}::timestamptz, ${after.submissionId}::uuid, ${after.seq}::int)`
              : undefined,
          ),
        )
        .orderBy(asc(changes.createdAt), asc(changes.submissionId), asc(changes.seq))
        .limit(limit + 1);
    },

    /**
     * Rejects the still-pending changes that act on entity `entityId` (as their target, or as a
     * relate's other end); returns their ids.
     */
    async rejectPendingTargeting(entityId: string, patch: ChangePatch) {
      const rows = await db
        .update(changes)
        .set({ ...patch, status: 'rejected' })
        .where(
          and(
            eq(changes.status, 'pending'),
            or(
              eq(changes.entityId, entityId),
              and(eq(changes.op, 'relate'), sql`${changes.payload}->>'to' = ${entityId}`),
            ),
          ),
        )
        .returning({ id: changes.id });
      return rows.map((r) => r.id);
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
