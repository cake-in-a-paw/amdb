import { z } from '@hono/zod-openapi';
import { ChangeOp, ChangeStatus, EntityKind, IdScheme, ImportSource, RelationType, WorkLinkType } from '@amdb/shared';
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

/**
 * What a redaction leaves in another change's `base` where it held the redacted value: it never
 * equals a real value, so approving that change still answers `stale_change`. The API never shows
 * it; `redactedBaseFields` lists those keys instead.
 */
export const RedactedValue = z.strictObject({ $redacted: z.literal(true) });
export const REDACTED_VALUE: z.infer<typeof RedactedValue> = { $redacted: true };

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
  /** Whether the change's content was erased (legal or abuse removal); `payload` and `base` are then null. */
  redacted: z.boolean(),
  redactionReason: z.string().nullable(),
  /** Null once redacted. After edit-and-approve, `payload.submitted` holds what the contributor sent. */
  payload: z.record(z.string(), z.unknown()).nullable(),
  /** The values the change was based on, without the ones a redaction erased. */
  base: z.record(z.string(), z.unknown()).nullable(),
  /** Keys of `base` whose recorded value was erased by a redaction (the change still can't apply over a newer value). */
  redactedBaseFields: z.array(z.string()),
  dependsOn: z.array(z.uuid()),
});

/** One change on its own, with the submission it belongs to. */
export const ChangeDetailSchema = ChangeSchema.extend({ submissionId: z.uuid() });

export const MyPendingQuery = z.object({ entityId: z.uuid() });
/** How many of the caller's edits touching the entry are still waiting for a moderator. */
export const MyPendingSchema = z.object({ count: z.number().int() });

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
        z.object({
          id: z.uuid(),
          seq: z.number().int(),
          op: ChangeOp,
          kind: EntityKind,
          /**
           * The entry the change is about, if it has one: an edit's target, or a relation's `from`
           * end, which is the work for most relations but the series or property for `series_work`
           * and `property_work`.
           */
          entityId: z.uuid().nullable(),
          status: ChangeStatus,
        }),
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

/** An import run as a change's author; `GET /api/import-runs/{id}` has its license evidence. */
const ImportRunAuthor = z.object({ importRun: z.object({ id: z.uuid(), source: ImportSource }) });

/** Who made a change, publicly: an import run, a handle if they chose one, else nothing that identifies them. */
export const AuthorSchema = z.union([
  z.literal('anonymous'),
  z.object({ handle: z.string().nullable() }),
  ImportRunAuthor,
]);

/** Who made a change, as moderators see it: the account id as well. */
export const ReviewAuthorSchema = z.union([
  z.literal('anonymous'),
  z.object({ userId: z.uuid(), handle: z.string().nullable() }),
  ImportRunAuthor,
]);

export const QueueSchema = z.object({
  items: z.array(
    z.object({
      change: ChangeSchema.extend({ submissionId: z.uuid(), createdAt: z.iso.datetime() }),
      submission: z.object({
        id: z.uuid(),
        author: ReviewAuthorSchema,
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
  /** A resubmit can add content, so it carries the CC0 agreement like a submit (constitution II). */
  cc0: z.literal(true),
  /** Merged into a create's or update's fields; null clears a field (a create then leaves it out). */
  fields: z.record(z.string(), z.unknown()).optional(),
  /** Merged into a relate's `data`. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type ResubmitInput = z.infer<typeof ResubmitInput>;

export const RedactInput = z.object({
  reason: z.string().trim().min(1).max(1000),
  /** Required when the change's content is still live: also takes it down (its entity, or a relate's relation). */
  removeEntity: z.boolean().optional(),
});
export type RedactInput = z.infer<typeof RedactInput>;

export const RedactedSchema = z.object({
  id: z.uuid(),
  /** What was taken down with the change, if its content was live. */
  entityId: z.uuid().nullable(),
  relationId: z.uuid().nullable(),
});

export const ClaimedSchema = z.object({ claimed: z.number().int() });

export const ReviewedSchema = z.object({ id: z.uuid(), status: ChangeStatus });

// --- Public history ---

export const HistoryParams = z.object({ id: z.uuid() });

export const HistoryQuery = z.object(PageQuery);

/** The decoded history cursor: the last item's (appliedAt, seq, id). */
export const HistoryCursor = z.object({ appliedAt: z.iso.datetime(), seq: z.number().int(), id: z.uuid() });

export const HistoryItemSchema = z.union([
  z.object({
    changeId: z.uuid(),
    op: ChangeOp,
    /** The change's fields; for a revert, `{ revertOf }`. */
    payload: z.record(z.string(), z.unknown()),
    author: AuthorSchema,
    /** `import` when an import run wrote the change; `author` names the run. */
    source: z.enum(['human', 'import']),
    appliedAt: z.iso.datetime(),
    revertOf: z.uuid().nullable(),
  }),
  /** A change erased for legal or abuse reasons: only who, when and why. */
  z.object({
    changeId: z.uuid(),
    op: ChangeOp,
    redacted: z.literal(true),
    reason: z.string().nullable(),
    author: AuthorSchema,
    appliedAt: z.iso.datetime(),
  }),
]);

export const HistorySchema = z.object({ items: z.array(HistoryItemSchema), nextCursor: z.string().nullable() });
