import type { Subtype } from '@amdb/shared';
import type { EntityView, Summary } from './entity';

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
