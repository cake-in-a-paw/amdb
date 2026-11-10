import { z } from '@hono/zod-openapi';
import { ArtSource } from '@amdb/shared';

/** The most works one `/api/art` request may ask about. */
export const MAX_ART_WORKS = 50;

export const ArtQuery = z.object({
  works: z
    .string()
    .refine(
      (v) => {
        const ids = v.split(',');
        return ids.length <= MAX_ART_WORKS && ids.every((id) => z.uuid().safeParse(id).success);
      },
      { message: `1 to ${MAX_ART_WORKS} comma-separated work ids` },
    )
    .openapi({ description: `Comma-separated work ids, at most ${MAX_ART_WORKS}` }),
});

export const ArtItemSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('found'),
      source: ArtSource,
      /** Small image, for API callers; the web shows only `full`. */
      thumb: z.string(),
      /** Large image, for the work page. */
      full: z.string(),
      /** The work's page at the source, for the credit. */
      link: z.string(),
    }),
    z.object({ status: z.literal('none') }),
    z.object({ status: z.literal('unavailable') }),
  ])
  .openapi({
    description:
      '`none`: no source has art (also for an unknown, removed or non-work id). `unavailable`: a source failed or timed out; ask again later.',
  });
export type ArtItem = z.infer<typeof ArtItemSchema>;

export const ArtSchema = z.object({
  /** Keyed by the ids as requested; a merged-away id gets its winner's art. */
  items: z.record(z.string(), ArtItemSchema),
});
