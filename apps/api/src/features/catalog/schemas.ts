import { z } from '@hono/zod-openapi';
import { EntityKind, IdScheme, MediaType, WorkLinkType } from '@amdb/shared';
import { PageQuery } from '../../platform/http/pagination';

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
  /** For each field, the id of the change that last set it. */
  fieldSources: z.record(z.string(), z.uuid()),
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

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  kind: EntityKind.optional(),
  /** Only works have a media type, so this limits results to works of it. */
  mediaType: MediaType.optional(),
  ...PageQuery,
});
export type SearchQuery = z.infer<typeof SearchQuery>;

/** The decoded search cursor: the last result's sort title and id. */
export const SearchCursor = z.object({ title: z.string(), id: z.uuid() });
export type SearchCursor = z.infer<typeof SearchCursor>;

export const SearchSchema = z.object({ items: z.array(SummarySchema), nextCursor: z.string().nullable() });

export const DuplicatesQuery = z.object({
  kind: EntityKind,
  title: z.string().trim().min(1).max(200),
  mediaType: MediaType.optional(),
});

/** Spec §5.3: a pending create shows only these four fields, to anyone. */
export const PendingDuplicateSchema = z.object({
  kind: EntityKind,
  title: z.string(),
  mediaType: MediaType.nullable(),
  releaseYear: z.number().int().nullable(),
});

export const DuplicatesSchema = z.object({
  existing: z.array(SummarySchema),
  pending: z.array(PendingDuplicateSchema),
});
