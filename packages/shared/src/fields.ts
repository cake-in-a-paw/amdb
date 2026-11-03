import { z } from 'zod';
import { CreatorKind, EntityKind, Lifecycle, MediaType, Subtype, TagKind } from './values';

const title = z.string().trim().min(1).max(500);
const description = z.string().max(5000);
const language = z.string().trim().min(1).max(35);

const FilmTvAttributes = z.strictObject({
  runtimeMin: z.number().int().positive().optional(),
  episodes: z.number().int().positive().optional(),
  originalLanguage: language.optional(),
});
const BookAttributes = z.strictObject({
  pageCount: z.number().int().positive().optional(),
  originalLanguage: language.optional(),
});

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The `create` shape for a work. Cross-field rules are refinements, so the update shape is the base's `.partial()`. */
export const WorkFieldsBase = z.object({
  mediaType: MediaType,
  subtype: Subtype.nullable(),
  title,
  originalTitle: title.optional(),
  description: description.optional(),
  releaseYear: z.number().int().min(1).max(9999).optional(),
  releaseMonth: z.number().int().min(1).max(12).optional(),
  releaseDay: z.number().int().min(1).max(31).optional(),
  lifecycle: Lifecycle,
  attributes: z.union([FilmTvAttributes, BookAttributes]).optional(),
});

/** The `create` shape: lifecycle defaults here only, so the partial update shape never injects it. */
export const WorkFields = WorkFieldsBase.extend({ lifecycle: Lifecycle.default('unknown') }).superRefine((w, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if ((w.mediaType === 'film_tv') !== (w.subtype !== null)) {
    issue('subtype', 'subtype is required for film_tv and not allowed for a book');
  }
  if (w.releaseMonth !== undefined && w.releaseYear === undefined) {
    issue('releaseMonth', 'releaseMonth needs releaseYear');
  }
  if (w.releaseDay !== undefined) {
    if (w.releaseMonth === undefined || w.releaseYear === undefined) {
      issue('releaseDay', 'releaseDay needs releaseMonth');
    } else if (w.releaseDay > daysInMonth(w.releaseYear, w.releaseMonth)) {
      issue('releaseDay', 'releaseDay is not valid for that month');
    }
  }
  if (w.attributes) {
    const schema = w.mediaType === 'book' ? BookAttributes : FilmTvAttributes;
    const r = schema.safeParse(w.attributes);
    if (!r.success) issue('attributes', `attributes do not fit ${w.mediaType}`);
  }
});

export const CreatorFields = z.object({
  name: title,
  kind: CreatorKind,
  description: description.optional(),
});

export const SeriesFields = z.object({ title, description: description.optional() });
export const PropertyFields = z.object({ title, description: description.optional() });

export const TagFields = z.object({
  kind: TagKind,
  name: title,
  slug: z.string().regex(/^[a-z0-9-]+$/),
});

export const FieldsFor = {
  work: WorkFields,
  creator: CreatorFields,
  series: SeriesFields,
  property: PropertyFields,
  tag: TagFields,
} satisfies Record<EntityKind, z.ZodType>;
