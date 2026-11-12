import type { ChangeOp, EntityKind, IdScheme, MediaType, Subtype } from '@amdb/shared';
import { and, arrayContains, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import {
  changes,
  creators,
  entities,
  importRuns,
  properties,
  relations,
  series,
  submissions,
  tags,
  users,
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

/** Who a submission is stored as written by: a contributor, or an import run. */
export type SubmissionAuthor = Owner | { importRunId: string };

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

/** A change with what its public and review author views need. */
const authorFields = {
  change: changes,
  authorUserId: submissions.authorUserId,
  authorHandle: users.handle,
  importRunId: submissions.importRunId,
  importSource: importRuns.source,
};

const ownerCondition = (owner: Owner) =>
  'userId' in owner ? eq(submissions.authorUserId, owner.userId) : eq(submissions.anonHash, owner.anonHash);

export function changesRepository(db: DbOrTx) {
  return {
    /** The tag holding `slug`, retracted or not (the unique index covers every tag). */
    async findTagBySlug(slug: string): Promise<string | null> {
      const [row] = await db.select({ id: tags.entityId }).from(tags).where(eq(tags.slug, slug));
      return row?.id ?? null;
    },

    /** The entity that holds an external id (scheme + value) right now, not counting the relations in `except`. */
    async findExternalIdHolder(scheme: string, value: string, except: string[] = []): Promise<string | null> {
      const [row] = await db
        .select({ id: relations.fromId })
        .from(relations)
        .where(
          and(
            eq(relations.type, 'external_id'),
            eq(relations.scheme, scheme as IdScheme),
            eq(relations.value, value),
            isNull(relations.removedByChange),
            except.length ? notInArray(relations.id, except) : undefined,
          ),
        );
      return row?.id ?? null;
    },

    /** The relation id of the child's live `work_part` (its parent link), not counting the relations in `except`. */
    async findParentLink(childId: string, except: string[] = []): Promise<string | null> {
      const [row] = await db
        .select({ id: relations.id })
        .from(relations)
        .where(
          and(
            eq(relations.type, 'work_part'),
            eq(relations.toId, childId),
            isNull(relations.removedByChange),
            except.length ? notInArray(relations.id, except) : undefined,
          ),
        );
      return row?.id ?? null;
    },

    /** A live entity (not removed, retracted or merged away) and, for a work, its media type and subtype. */
    async findEntity(
      id: string,
    ): Promise<{ kind: EntityKind; mediaType: MediaType | null; subtype: Subtype | null } | null> {
      const [row] = await db
        .select({ kind: entities.kind, mediaType: works.mediaType, subtype: works.subtype })
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
      return row ? { kind: row.kind, mediaType: row.mediaType, subtype: row.subtype } : null;
    },

    /** Whether the entity was taken down by a redaction. */
    async isRemoved(id: string) {
      const [row] = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.id, id), isNotNull(entities.removedAt)));
      return !!row;
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

    async insertSubmission(owner: SubmissionAuthor, note: string | undefined, rows: NewChange[]) {
      const [submission] = await db
        .insert(submissions)
        .values({
          authorUserId: 'userId' in owner ? owner.userId : null,
          anonHash: 'anonHash' in owner ? owner.anonHash : null,
          importRunId: 'importRunId' in owner ? owner.importRunId : null,
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

    /** Moves the anonymous token's submissions to the user in one statement; returns how many. */
    async claimSubmissions(anonHash: string, userId: string) {
      const rows = await db
        .update(submissions)
        .set({ authorUserId: userId, anonHash: null })
        .where(eq(submissions.anonHash, anonHash))
        .returning({ id: submissions.id });
      return rows.length;
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

    /** Rejects the still-pending unrelates of relation `relationId`; returns their ids. */
    async rejectPendingUnrelates(relationId: string, patch: ChangePatch) {
      const rows = await db
        .update(changes)
        .set({ ...patch, status: 'rejected' })
        .where(and(eq(changes.status, 'pending'), eq(changes.op, 'unrelate'), eq(changes.relationId, relationId)))
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
      // The entity and everything merged into it, transitively: their history is its history.
      const family = (cast: 'uuid' | 'text') =>
        sql`(with recursive family(id) as (select ${entityId}::uuid union select e.id from entities e join family f on e.merged_into_id = f.id) select id::${sql.raw(cast)} from family)`;
      const ids = family('uuid');
      const idsText = family('text');
      return db
        .select(authorFields)
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .leftJoin(users, eq(users.id, submissions.authorUserId))
        .leftJoin(importRuns, eq(importRuns.id, submissions.importRunId))
        .where(
          and(
            inArray(changes.status, ['approved', 'published']),
            or(
              sql`${changes.entityId} in ${ids}`,
              // A merge into this entity or one merged into it (`into` may have resolved further
              // when the merge applied), and the revert of one.
              and(
                eq(changes.op, 'merge'),
                or(sql`${changes.payload}->>'into' in ${idsText}`, sql`${changes.inverse}->>'into' in ${idsText}`),
              ),
              sql`exists (select 1 from ${changes} m where m.op = 'merge' and (m.payload->>'into' in ${idsText} or m.inverse->>'into' in ${idsText}) and m.id::text = ${changes.payload}->>'revertOf')`,
              sql`${changes.relationId} in (select ${relations.id} from ${relations} where ${relations.fromId} in ${ids} or ${relations.toId} in ${ids})`,
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
        .select(authorFields)
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .leftJoin(users, eq(users.id, submissions.authorUserId))
        .leftJoin(importRuns, eq(importRuns.id, submissions.importRunId))
        .where(
          and(
            inArray(changes.status, ['pending', 'published']),
            isNull(changes.redactedAt),
            after
              ? sql`(${changes.createdAt}, ${changes.submissionId}, ${changes.seq}) > (${after.createdAt}::timestamptz, ${after.submissionId}::uuid, ${after.seq}::int)`
              : undefined,
          ),
        )
        .orderBy(asc(changes.createdAt), asc(changes.submissionId), asc(changes.seq))
        .limit(limit + 1);
    },

    /**
     * Rejects the still-pending changes that act on entity `entityId` (as their target, a
     * relate's other end, or a merge's `into`); returns their ids.
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
              and(eq(changes.op, 'merge'), sql`${changes.payload}->>'into' = ${entityId}`),
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

    /**
     * How many of the owner's pending edits touch an entry: as their target, or as either end of a
     * relation they add or remove. A series or property link is recorded on its `from` end, so the
     * `to` end is read from the payload (a relate) or the relation (an unrelate).
     */
    async countPending(owner: Owner, entityId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(changes)
        .innerJoin(submissions, eq(submissions.id, changes.submissionId))
        .leftJoin(relations, eq(relations.id, changes.relationId))
        .where(
          and(
            ownerCondition(owner),
            eq(changes.status, 'pending'),
            sql`${changes.op} <> 'create'`,
            or(
              eq(changes.entityId, entityId),
              sql`${changes.payload}->>'to' = ${entityId}`,
              eq(relations.toId, entityId),
            ),
          ),
        );
      return row?.count ?? 0;
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
              entityId: changes.entityId,
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
