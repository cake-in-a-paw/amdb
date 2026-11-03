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

export const SubmissionDetailSchema = z.object({
  id: z.uuid(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** The account that submitted it; null for an anonymous submission, whose token is never shown. */
  authorUserId: z.uuid().nullable(),
  changes: z.array(
    z.object({
      id: z.uuid(),
      seq: z.number().int(),
      op: ChangeOp,
      kind: EntityKind,
      entityId: z.uuid().nullable(),
      relationId: z.uuid().nullable(),
      status: ChangeStatus,
      reason: z.string().nullable(),
      /** Null once redacted. */
      payload: z.record(z.string(), z.unknown()).nullable(),
      base: z.record(z.string(), z.unknown()).nullable(),
      dependsOn: z.array(z.uuid()),
    }),
  ),
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
