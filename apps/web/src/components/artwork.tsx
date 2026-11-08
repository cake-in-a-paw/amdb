import { useState } from 'react';
import type { ArtItem } from '@/lib/art';

type Found = Extract<ArtItem, { status: 'found' }>;

const credits = { tmdb: 'Poster: TMDB', openlibrary: 'Cover: Open Library', anilist: 'Cover: AniList' } as const;

/** The item if it has an image that hasn't failed to load. */
function usable(item: ArtItem | undefined, failed: string | null): Found | null {
  return item?.status === 'found' && failed !== item.full ? item : null;
}

/**
 * A work page's image, 2:3, with a credit link under it. Before the art loads, and when there is
 * none, it can't load or the image fails, the title stands in, set as a book spine would be.
 */
export function Poster({ title, item }: { title: string; item: ArtItem | undefined }) {
  const [failed, setFailed] = useState<string | null>(null);
  const art = usable(item, failed);
  if (!art) {
    return (
      <div
        role="img"
        aria-label={`No cover for ${title}`}
        className="flex aspect-[2/3] w-40 items-center justify-center rounded-md border border-border bg-secondary p-4 text-center font-serif text-xl leading-snug text-balance text-muted-foreground"
      >
        {title}
      </div>
    );
  }
  return (
    <div className="w-40">
      <img
        src={art.full}
        alt={`${art.source === 'tmdb' ? 'Poster' : 'Cover'} for ${title}`}
        loading="lazy"
        onError={() => setFailed(art.full)}
        className="aspect-[2/3] w-40 rounded-md border border-border bg-secondary object-cover"
      />
      <a
        href={art.link}
        rel="noreferrer"
        className="inline-flex min-h-11 min-w-11 items-center text-sm text-muted-foreground underline underline-offset-4"
      >
        {credits[art.source]}
      </a>
    </div>
  );
}
