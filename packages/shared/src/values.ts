import { z } from 'zod';

export const EntityKind = z.enum(['work', 'creator', 'series', 'property', 'tag']);
export type EntityKind = z.infer<typeof EntityKind>;

/** The sites art is linked from, in the order they are tried. */
export const ArtSource = z.enum(['tmdb', 'openlibrary', 'anilist']);
export type ArtSource = z.infer<typeof ArtSource>;

export const MediaType = z.enum(['film_tv', 'book']);
export type MediaType = z.infer<typeof MediaType>;

/** film_tv only; null for a book. */
export const Subtype = z.enum(['movie', 'series', 'anime_series', 'anime_film', 'season', 'episode']);
export type Subtype = z.infer<typeof Subtype>;

export const Lifecycle = z.enum(['released', 'upcoming', 'airing', 'unknown']);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const CreatorKind = z.enum(['person', 'organization']);
export type CreatorKind = z.infer<typeof CreatorKind>;

export const CreatorRole = {
  film_tv: z.enum(['director', 'writer', 'creator', 'producer', 'studio', 'composer']),
  book: z.enum(['author', 'illustrator', 'translator', 'editor']),
};

export const RelationType = z.enum([
  'work_creator',
  'series_work',
  'property_work',
  'work_link',
  'work_tag',
  'external_id',
  'work_part',
]);
export type RelationType = z.infer<typeof RelationType>;

export const WorkLinkType = z.enum(['adapted_from', 'sequel_of', 'remake_of', 'spin_off_of']);
export type WorkLinkType = z.infer<typeof WorkLinkType>;

export const TagKind = z.enum(['genre', 'theme', 'content_warning']);
export type TagKind = z.infer<typeof TagKind>;

export const IdScheme = z.enum([
  'wikidata',
  'openlibrary',
  'isbn13',
  'imdb',
  'tmdb_movie',
  'tmdb_tv',
  'tmdb_season',
  'tmdb_episode',
  'anilist',
]);
export type IdScheme = z.infer<typeof IdScheme>;

export const ChangeOp = z.enum(['create', 'update', 'relate', 'unrelate', 'merge']);
export type ChangeOp = z.infer<typeof ChangeOp>;

export const ChangeStatus = z.enum(['pending', 'published', 'approved', 'rejected']);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

/** A public handle: 3-30 letters, digits, underscores or hyphens. Stored lowercase; unique ignoring case. */
export const Handle = z.string().regex(/^[A-Za-z0-9_-]{3,30}$/, 'Use 3–30 letters, digits, "_" or "-"');
export type Handle = z.infer<typeof Handle>;

/** Words a handle may not be, since public attribution already uses them. */
export const RESERVED_HANDLES = ['anonymous', 'contributor', 'admin', 'moderator'] as const;

export const Role = z.enum(['contributor', 'moderator', 'admin']);
export type Role = z.infer<typeof Role>;

/** Where an import run reads from. */
export const ImportSource = z.enum(['wikidata']);
export type ImportSource = z.infer<typeof ImportSource>;

/** An import run's state: `capped` stopped at the database size cap. */
export const ImportRunStatus = z.enum(['running', 'finished', 'failed', 'capped']);
export type ImportRunStatus = z.infer<typeof ImportRunStatus>;
