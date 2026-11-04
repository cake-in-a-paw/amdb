import { Link } from '@tanstack/react-router';
import { mediaTypeLabels } from '@/lib/labels';
import type { Summary } from '@/lib/entity';

/** "Film & TV, 2001": a work's media type and year, as far as they're known. */
export function summaryDetail(entry: Pick<Summary, 'mediaType' | 'releaseYear'>): string {
  return [entry.mediaType && mediaTypeLabels[entry.mediaType], entry.releaseYear].filter(Boolean).join(', ');
}

/**
 * One line of an index: the title, a dotted leader, and the details ("Spirited Away ······ Film &
 * TV, 2001"). A `<li>`, to sit in a list the caller names.
 */
export function EntryRow({ entry, detail = summaryDetail(entry) }: { entry: Summary; detail?: string }) {
  return (
    <li className="border-b border-border/70">
      <Link
        to="/entities/$id"
        params={{ id: entry.id }}
        className="group flex min-h-11 min-w-11 items-baseline gap-3 py-2.5 hover:bg-secondary/60"
      >
        <span className="font-serif text-lg leading-snug group-hover:underline group-hover:underline-offset-4">
          {entry.title}
        </span>
        <span aria-hidden="true" className="leader flex-1" />
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{detail}</span>
      </Link>
    </li>
  );
}
