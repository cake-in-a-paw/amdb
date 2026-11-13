import type {
  CreatorKind,
  EntityKind,
  IdScheme,
  Lifecycle,
  MediaType,
  Subtype,
  TagKind,
  WorkLinkType,
} from '@amdb/shared';

/**
 * Display words for the API's value lists, in one place. Keyed by the shared types, so a new value
 * in `@amdb/shared` fails typecheck here until it has words.
 */

export const mediaTypeLabels: Record<MediaType, string> = { film_tv: 'Film & TV', book: 'Book' };

export const subtypeLabels: Record<Subtype, string> = {
  movie: 'Movie',
  series: 'Series',
  anime_series: 'Anime series',
  anime_film: 'Anime film',
  season: 'Season',
  episode: 'Episode',
};

export const lifecycleLabels: Record<Lifecycle, string> = {
  released: 'Released',
  upcoming: 'Upcoming',
  airing: 'Airing',
  unknown: 'Unknown',
};

export const creatorKindLabels: Record<CreatorKind, string> = { person: 'Person', organization: 'Organization' };

export const tagKindLabels: Record<TagKind, string> = {
  genre: 'Genre',
  theme: 'Theme',
  content_warning: 'Content warning',
};

export const idSchemeLabels: Record<IdScheme, string> = {
  wikidata: 'Wikidata',
  openlibrary: 'Open Library',
  isbn13: 'ISBN-13',
  imdb: 'IMDb',
  tmdb_movie: 'TMDB (movie)',
  tmdb_tv: 'TMDB (TV)',
  tmdb_season: 'TMDB (season)',
  tmdb_episode: 'TMDB (episode)',
  anilist: 'AniList',
};

/** Singular and plural names for each kind of entry. */
export const kindLabels: Record<EntityKind, { singular: string; plural: string }> = {
  work: { singular: 'Work', plural: 'Works' },
  creator: { singular: 'Creator', plural: 'Creators' },
  series: { singular: 'Series', plural: 'Series' },
  property: { singular: 'Property', plural: 'Properties' },
  tag: { singular: 'Tag', plural: 'Tags' },
};

/** The order kinds are listed in, wherever they are grouped or tabbed. */
export const kindOrder: readonly EntityKind[] = ['work', 'creator', 'series', 'property', 'tag'];

/** A link between works, read from the work that owns it (`outgoing`) or from the other end. */
export const workLinkLabels: Record<WorkLinkType, { outgoing: string; incoming: string }> = {
  adapted_from: { outgoing: 'Adapted from', incoming: 'Adapted as' },
  sequel_of: { outgoing: 'Sequel to', incoming: 'Followed by' },
  remake_of: { outgoing: 'Remake of', incoming: 'Remade as' },
  spin_off_of: { outgoing: 'Spin-off of', incoming: 'Spun off as' },
};

/** Credit roles are stored as snake_case keys ("director"); this is the words for any of them. */
export function roleLabel(role: string): string {
  const spaced = role.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A credit's roles in words, in the order given: "Director, Writer". */
export function rolesLabel(roles: string[]): string {
  return roles.map(roleLabel).join(', ');
}

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A release date at the precision it was given: "2001", "July 2001" or "July 20, 2001". */
export function formatReleaseDate(year?: unknown, month?: unknown, day?: unknown): string | null {
  if (typeof year !== 'number') return null;
  const monthName = typeof month === 'number' ? months[month - 1] : undefined;
  if (!monthName) return String(year);
  return typeof day === 'number' ? `${monthName} ${day}, ${year}` : `${monthName} ${year}`;
}

/** Field keys as words, for the history ("releaseYear" is "Release year"). */
export function fieldLabel(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
