import { useId, type ReactNode } from 'react';
import { EntryRow } from '@/components/entry-row';
import type { ArtItem } from '@/lib/art';
import type { Summary } from '@/lib/entity';

/**
 * A titled group of works under a work or list page ("More by …", "Adapted from"). The title may
 * hold links; the group is a region named by it.
 */
export function RelatedWorks({
  title,
  note,
  works,
  empty,
  art,
}: {
  title: ReactNode;
  /** A line under the title, such as where this work stands in the series. */
  note?: string;
  works: { entry: Summary; detail?: string }[];
  /** What to say when `works` is empty; without it an empty group renders nothing. */
  empty?: string;
  /** Art by work id, for the thumbnails. */
  art?: Map<string, ArtItem | undefined>;
}) {
  const headingId = useId();
  if (works.length === 0 && !empty) return null;
  return (
    <section aria-labelledby={headingId} className="mt-8">
      <h2 id={headingId} className="border-b border-border pb-2 font-serif text-xl font-semibold">
        {title}
      </h2>
      {note && <p className="pt-2 text-sm text-muted-foreground">{note}</p>}
      {works.length === 0 ? (
        <p className="py-3 text-muted-foreground">{empty}</p>
      ) : (
        <ul aria-labelledby={headingId}>
          {works.map(({ entry, detail }) => (
            <EntryRow key={entry.id} entry={entry} detail={detail} art={art} />
          ))}
        </ul>
      )}
    </section>
  );
}
