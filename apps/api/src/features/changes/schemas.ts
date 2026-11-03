import { z } from '@hono/zod-openapi';
import { ChangeOp, ChangeStatus, EntityKind, IdScheme, RelationType, WorkLinkType } from '@amdb/shared';
import { PageQuery } from '../../platform/http/pagination';

/** An entity named by id, or by the `ref` of a create earlier in the same submission. */
export const EntityRef = z.union([z.object({ id: z.uuid() }), z.object({ ref: z.string().min(1).max(40) })]);
export type EntityRef = z.infer<typeof EntityRef>;

export const ChangeInput = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    kind: EntityKind,
    ref: z.string().min(1).max(40),
    fields: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('update'),
    kind: EntityKind,
    entityId: z.uuid(),
    fields: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('relate'),
    type: RelationType,
    from: EntityRef,
    to: EntityRef.optional(),
    data: z
      .object({
        role: z.string(),
        position: z.number().int().min(1),
        linkType: WorkLinkType,
        scheme: IdScheme,
        value: z.string(),
      })
      .partial(),
  }),
  z.object({ op: z.literal('unrelate'), relationId: z.uuid() }),
  z.object({ op: z.literal('merge'), kind: EntityKind, from: z.uuid(), into: z.uuid() }),
]);
export type ChangeInput = z.infer<typeof ChangeInput>;

export const SubmissionInput = z.object({
  cc0: z.literal(true),
  note: z.string().max(2000).optional(),
  changes: z.array(ChangeInput).min(1).max(200),
});
export type SubmissionInput = z.infer<typeof SubmissionInput>;

export const SubmissionCreatedSchema = z.object({
  id: z.uuid(),
  changes: z.array(
    z.object({
      id: z.uuid(),
      seq: z.number().int(),
      op: ChangeOp,
      status: ChangeStatus,
      entityId: z.uuid().nullable(),
    }),
  ),
});

/** A change as its author and moderators see it. */
export const ChangeSchema = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  op: ChangeOp,
  kind: EntityKind,
  entityId: z.uuid().nullable(),
  relationId: z.uuid().nullable(),
  status: ChangeStatus,
  reason: z.string().nullable(),
  /** Null once redacted. After edit-and-approve, `payload.submitted` holds what the contributor sent. */
  payload: z.record(z.string(), z.unknown()).nullable(),
  base: z.record(z.string(), z.unknown()).nullable(),
  dependsOn: z.array(z.uuid()),
});

export const SubmissionDetailSchema = z.object({
  id: z.uuid(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** The account that submitted it; null for an anonymous submission, whose token is never shown. */
  authorUserId: z.uuid().nullable(),
  changes: z.array(ChangeSchema),
});

export const MySubmissionsQuery = z.object(PageQuery);

export const MySubmissionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      note: z.string().nullable(),
      createdAt: z.iso.datetime(),
      changes: z.array(
        z.object({ id: z.uuid(), seq: z.number().int(), op: ChangeOp, kind: EntityKind, status: ChangeStatus }),
      ),
    }),
  ),
  nextCursor: z.string().nullable(),
});

// --- Stored payloads (what a change row's `payload` holds, per op) ---

export const RelatePayload = z.object({
  type: RelationType,
  from: z.uuid(),
  to: z.uuid().nullable(),
  data: z
    .object({
      role: z.string(),
      position: z.number().int(),
      linkType: WorkLinkType,
      scheme: IdScheme,
      value: z.string(),
    })
    .partial(),
});
export const UnrelatePayload = z.object({ relationId: z.uuid() });
export const MergePayload = z.object({ from: z.uuid(), into: z.uuid() });

// --- Moderation ---

export const ChangeIdParam = z.object({ id: z.uuid() });

export const QueueQuery = z.object(PageQuery);

/** The decoded queue cursor: the last item's (createdAt, submissionId, seq). */
export const QueueCursor = z.object({ createdAt: z.iso.datetime(), submissionId: z.uuid(), seq: z.number().int() });

export const QueueSchema = z.object({
  items: z.array(
    z.object({
      change: ChangeSchema.extend({ submissionId: z.uuid(), createdAt: z.iso.datetime() }),
      submission: z.object({
        id: z.uuid(),
        author: z.union([z.literal('anonymous'), z.object({ userId: z.uuid() })]),
      }),
      ageSeconds: z.number().int(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const ApproveInput = z.object({
  /** Edit-and-approve: merged into a create's or update's fields; the original is kept as `payload.submitted`. */
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type ApproveInput = z.infer<typeof ApproveInput>;

export const RejectInput = z.object({ reason: z.string().trim().min(1).max(1000) });

export const ResubmitInput = z.object({
  /** Merged into a create's or update's fields. */
  fields: z.record(z.string(), z.unknown()).optional(),
  /** Merged into a relate's `data`. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ResubmitInput = z.infer<typeof ResubmitInput>;

export const ReviewedSchema = z.object({ id: z.uuid(), status: ChangeStatus });
