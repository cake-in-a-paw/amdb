import { PART_OF, PART_SUBTYPES, type Subtype } from '@amdb/shared';
import type { EntityView, Summary } from './entity';

type PartSubtype = keyof (typeof PART_OF)[keyof typeof PART_OF];

/** Each part subtype counted in words; keyed by `PART_OF`, so a new part subtype fails typecheck until it has them. */
const partNouns: Record<PartSubtype, { one: string; many: string }> = {
  season: { one: 'season', many: 'seasons' },
  episode: { one: 'episode', many: 'episodes' },
};
const nounsOf: Partial<Record<Subtype, { one: string; many: string }>> = partNouns;

/**
 * How many of each part a creator is credited on, in parts order: "2 seasons, 14 episodes",
 * "1 episode". No parts is ''.
 */
export function creditPartsLabel(parts: Partial<Record<Subtype, number>>): string {
  return PART_SUBTYPES.flatMap((subtype) => {
    const n = parts[subtype];
    const nouns = nounsOf[subtype];
    return n && nouns ? [`${n} ${n === 1 ? nouns.one : nouns.many}`] : [];
  }).join(', ');
}

/** One work above another in its show, as the API lists them: root first, parent last. */
export type Ancestor = NonNullable<EntityView['relations']['ancestors']>[number];

/**
 * What a part is called by its place in the show: "Season 2", "Specials" (season 0), "S2E14" for
 * an episode of a numbered season, "Episode 5" for one directly under a show (or an unnumbered
 * season). A missing number reads "Season", "S2E?" or "Episode". Anything that isn't a part is ''.
 */
export function partLabel(subtype: Subtype | null, position: number | undefined, ancestors: Ancestor[]): string {
  switch (subtype) {
    case 'season':
      return position === undefined ? 'Season' : position === 0 ? 'Specials' : `Season ${position}`;
    case 'episode': {
      const parent = ancestors.at(-1);
      if (parent?.subtype === 'season' && parent.position !== undefined) {
        return `S${parent.position}E${position ?? '?'}`;
      }
      return position === undefined ? 'Episode' : `Episode ${position}`;
    }
    default:
      return '';
  }
}

/**
 * A card's title, with a part's context: "Breaking Bad · S1E1 · Pilot". A season reads only
 * "Breaking Bad · Season 2", since its own title usually repeats the show's. A removed root is left
 * out, and anything that isn't a part is its title.
 */
export function partTitle(summary: Summary): string {
  const { part } = summary;
  if (!part) return summary.title;
  const root = part.ancestors[0];
  return [
    root && !root.removed ? root.title : '',
    partLabel(part.subtype, part.position, part.ancestors),
    part.subtype === 'season' ? '' : summary.title,
  ]
    .filter(Boolean)
    .join(' · ');
}
