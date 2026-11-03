import { z } from '@hono/zod-openapi';
import { EntityKind, IdScheme, MediaType, WorkLinkType } from '@amdb/shared';

export const EntityIdParam = z.object({ id: z.uuid() });

/** How an entity appears inside another's relations. A creator's or tag's name is its `title`. */
export const SummarySchema = z.object({
  id: z.uuid(),
  kind: EntityKind,
  title: z.string(),
  mediaType: MediaType.optional(),
  releaseYear: z.number().int().optional(),
});
export type Summary = z.infer<typeof SummarySchema>;

const relationId = z.uuid();

/** Only the groups relevant to the entity's kind are present. */
export const EntitySchema = z.object({
  id: z.uuid(),
  kind: EntityKind,
  fields: z.record(z.string(), z.unknown()),
  relations: z.object({
    /** A work's creators, with their role and credit position. */
    creators: z
      .array(z.object({ relationId, creator: SummarySchema, role: z.string(), position: z.number().int().optional() }))
      .optional(),
    /** The works of a creator, series, property or tag. */
    works: z
      .array(
        z.object({
          relationId,
          work: SummarySchema,
          role: z.string().optional(),
          position: z.number().int().optional(),
        }),
      )
      .optional(),
    series: z.array(z.object({ relationId, series: SummarySchema, position: z.number().int() })).optional(),
    properties: z.array(z.object({ relationId, property: SummarySchema })).optional(),
    links: z
      .array(
        z.object({
          relationId,
          type: WorkLinkType,
          direction: z.enum(['outgoing', 'incoming']),
          work: SummarySchema,
        }),
      )
      .optional(),
    tags: z.array(z.object({ relationId, tag: SummarySchema })).optional(),
    externalIds: z.array(z.object({ relationId, scheme: IdScheme, value: z.string() })).optional(),
  }),
});
export type EntityView = z.infer<typeof EntitySchema>;
