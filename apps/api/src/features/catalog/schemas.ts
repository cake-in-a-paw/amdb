import { z } from '@hono/zod-openapi';
import { EntityKind, IdScheme, MediaType, Subtype, WorkLinkType } from '@amdb/shared';
import { PageQuery } from '../../platform/http/pagination';

export const EntityIdParam = z.object({ id: z.uuid() });

/** One work above another in its tree. `position` is the ancestor's own number under its parent; a removed one keeps its id and stored title. */
export const AncestorSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  subtype: Subtype.nullable(),
  position: z.number().int().optional(),
  removed: z.boolean(),
});
export type Ancestor = z.infer<typeof AncestorSchema>;

/** How an entity appears inside another's relations. A creator's or tag's name is its `title`. */
export const SummarySchema = z.object({
  id: z.uuid(),
  kind: EntityKind,
  title: z.string(),
  mediaType: MediaType.optional(),
  releaseYear: z.number().int().optional(),
  /**
   * Search with `includeParts=true` only: a part with a live parent, its own subtype and number
   * under that parent, and its ancestors root first.
   */
  part: z
    .object({ subtype: Subtype, position: z.number().int().optional(), ancestors: z.array(AncestorSchema) })
    .optional(),
});
export type Summary = z.infer<typeof SummarySchema>;

/** The most works a "more like this" group lists. */
export const RELATED_LIMIT = 12;

const relatedWorks = z.array(SummarySchema);

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
    /**
     * A creator's credits, one row per root work (a show, a film, an orphan part), in order of
     * each row's earliest credit. `roles` are every role the creator holds at or under the root;
     * `parts` counts the credited works under it by subtype. A root taken down while its parts
     * stay listed is `removed`, with its stored title.
     */
    credits: z
      .array(
        z.object({
          work: SummarySchema,
          removed: z.boolean(),
          roles: z.array(z.string()),
          parts: z.partialRecord(Subtype, z.number().int()),
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
    /** A work's live parent, removed or not; null for a root. */
    parent: z
      .object({ relationId, work: SummarySchema, position: z.number().int().optional(), removed: z.boolean() })
      .nullable()
      .optional(),
    /** A work's ancestors, root first, its parent last; empty for a root. */
    ancestors: z.array(AncestorSchema).optional(),
    /** How many live, listed parts a work has; they're paged from `/api/entities/{id}/parts`. */
    partCount: z.number().int().optional(),
    externalIds: z.array(z.object({ relationId, scheme: IdScheme, value: z.string() })).optional(),
    /** A work's other works by shared creator, series or property: each group at most 12, by release year then title. */
    related: z
      .object({
        byCreator: z.array(z.object({ creator: SummarySchema, works: relatedWorks })),
        bySeries: z.array(z.object({ series: SummarySchema, works: relatedWorks })),
        byProperty: z.array(z.object({ property: SummarySchema, works: relatedWorks })),
      })
      .optional(),
  }),
});
export type EntityView = z.infer<typeof EntitySchema>;

export const SearchQuery = z
  .object({
    q: z.string().trim().min(1).max(200),
    kind: EntityKind.optional(),
    /** Only works have a media type, so this limits results to works of it. */
    mediaType: MediaType.optional(),
    /** `true` also finds parts (seasons, episodes), each with its ancestors. Left out by default. */
    includeParts: z.enum(['true', 'false']).optional(),
    ...PageQuery,
  })
  .refine((q) => !q.mediaType || !q.kind || q.kind === 'work', {
    message: 'mediaType only applies to works',
    path: ['mediaType'],
  });
export type SearchQuery = z.infer<typeof SearchQuery>;

/** The decoded search cursor: the last result's rank (1 for an alternate-name-only match), sort title and id. A cursor without a rank decodes as 0. */
export const SearchCursor = z.object({
  rank: z.union([z.literal(0), z.literal(1)]).default(0),
  title: z.string(),
  id: z.uuid(),
});
export type SearchCursor = z.infer<typeof SearchCursor>;

export const BrowseQuery = z
  .object({ kind: EntityKind, mediaType: MediaType.optional(), ...PageQuery })
  .refine((q) => !q.mediaType || q.kind === 'work', {
    message: 'mediaType only applies to works',
    path: ['mediaType'],
  });
export type BrowseQuery = z.infer<typeof BrowseQuery>;

export const SearchSchema = z.object({ items: z.array(SummarySchema), nextCursor: z.string().nullable() });

export const DuplicatesQuery = z
  .object({
    kind: EntityKind,
    title: z.string().trim().min(1).max(200),
    mediaType: MediaType.optional(),
    /** Match only the live, listed parts of this work: siblings of the part being created. */
    parentId: z.uuid().optional(),
  })
  .refine((q) => !q.mediaType || q.kind === 'work', {
    message: 'mediaType only applies to works',
    path: ['mediaType'],
  })
  .refine((q) => !q.parentId || q.kind === 'work', {
    message: 'parentId only applies to works',
    path: ['parentId'],
  });
export type DuplicatesQuery = z.infer<typeof DuplicatesQuery>;

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

export const PartsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The decoded parts cursor: the last part's sort key. `b` is 0 for a numbered part, 1 for one
 * with no number, 2 for a zero-last subtype numbered 0; `p` the number (0 if none); `y`, `m`, `d`
 * the release date with gaps past every real value; `t` the title; `id` the part's id.
 */
export const PartsCursor = z.object({
  b: z.number().int(),
  p: z.number().int(),
  y: z.number().int(),
  m: z.number().int(),
  d: z.number().int(),
  t: z.string(),
  id: z.uuid(),
});
export type PartsCursor = z.infer<typeof PartsCursor>;

export const PartsSchema = z.object({
  items: z.array(
    z.object({ relationId, work: SummarySchema, subtype: Subtype.nullable(), position: z.number().int().optional() }),
  ),
  nextCursor: z.string().nullable(),
});
