import type { MediaType, Subtype } from './values';

/**
 * Which subtypes a work of each subtype may be a part of, per media type. A part has its parent's
 * media type, and subtypes missing from a media type's table (movies, series) are roots that never
 * have a parent. Music rows (`track` under `album | single | ep`) and games rows (`expansion` and
 * `dlc` under `game`; `dlc` under `expansion`) are added when those media types ship.
 */
export const PART_OF = {
  film_tv: {
    season: ['series', 'anime_series'],
    episode: ['season', 'series', 'anime_series'],
  },
} as const satisfies Partial<Record<MediaType, Partial<Record<Subtype, readonly Subtype[]>>>>;

/** Subtypes that are parts: a work with one is a part whether or not it is attached yet. */
export const PART_SUBTYPES: readonly Subtype[] = [
  ...new Set(Object.values(PART_OF).flatMap((rows) => Object.keys(rows) as Subtype[])),
];

/** Part subtypes whose numbering starts at 0, so a numbered 0 sorts last, not first. */
export const ZERO_LAST_SUBTYPES: readonly Subtype[] = ['season'];

export function isPartSubtype(subtype: Subtype | null): boolean {
  return subtype !== null && PART_SUBTYPES.includes(subtype);
}

export type WorkShape = { mediaType: MediaType; subtype: Subtype | null };

/** Whether the tree list lets `child` sit directly under `parent`. */
export function canBePartOf(child: WorkShape, parent: WorkShape): boolean {
  if (child.mediaType !== parent.mediaType || child.subtype === null || parent.subtype === null) return false;
  // The table is keyed by media type then subtype; a missing row means "never a part".
  const rows: Partial<Record<MediaType, Partial<Record<Subtype, readonly Subtype[]>>>> = PART_OF;
  return rows[child.mediaType]?.[child.subtype]?.includes(parent.subtype) ?? false;
}
