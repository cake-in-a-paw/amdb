import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useId } from 'react';
import type { EntityKind, MediaType } from '@amdb/shared';
import { summaryDetail } from '@/components/entry-row';
import { unwrap } from '@/lib/api';
import { useDebounced } from '@/lib/debounce';
import { describeError } from '@/lib/errors';
import { linkClass } from '@/lib/styles';

const rootRoute = getRouteApi('__root__');

/**
 * Entries like the one being added, asked of `/api/duplicates` 300ms after typing stops: ones
 * already in the catalog (each with a way to edit it instead), and pending creates, which show
 * only their title, type and year. Advice only; it never blocks the form. `excludeId` is the entry
 * being edited, so it doesn't flag itself. `level` is its heading's, one below the page's own.
 */
export function DuplicateCheck({
  kind,
  title,
  mediaType,
  excludeId,
  level = 2,
}: {
  kind: EntityKind;
  title: string;
  mediaType?: MediaType;
  excludeId?: string | undefined;
  level?: 2 | 3 | undefined;
}) {
  const { api } = rootRoute.useRouteContext();
  const id = useId();
  const settled = useDebounced(title.trim(), 300);
  // mediaType only narrows works; the API refuses it for any other kind.
  const media = kind === 'work' ? mediaType : undefined;
  const query = useQuery({
    queryKey: ['duplicates', kind, settled, media],
    enabled: settled !== '',
    queryFn: async ({ signal }) =>
      unwrap(
        await api.GET('/api/duplicates', {
          params: { query: { kind, title: settled, ...(media ? { mediaType: media } : {}) } },
          signal,
        }),
      ),
  });

  const Heading = level === 2 ? 'h2' : 'h3';
  const Subheading = level === 2 ? 'h3' : 'h4';
  const existing = query.data?.existing.filter((entry) => entry.id !== excludeId) ?? [];
  if (settled === '') return null;
  return (
    <section aria-labelledby={`${id}-heading`} aria-live="polite" className="text-sm">
      <Heading id={`${id}-heading`} className="sr-only">
        Possible duplicates
      </Heading>
      {query.isPending ? (
        <p role="status" className="text-muted-foreground">
          Checking for duplicates…
        </p>
      ) : query.isError ? (
        <p className="text-muted-foreground">Couldn't check for duplicates. {describeError(query.error, '')}</p>
      ) : existing.length === 0 && query.data.pending.length === 0 ? (
        <p className="text-muted-foreground">No similar entries in the catalog.</p>
      ) : (
        <div className="grid gap-3 rounded-md border border-border bg-card p-3">
          {existing.length > 0 && (
            <div>
              <Subheading id={`${id}-existing`} className="font-medium">
                Already in the catalog
              </Subheading>
              <ul aria-labelledby={`${id}-existing`}>
                {existing.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3">
                    <Link to="/entities/$id" params={{ id: entry.id }} className={`${linkClass} font-serif text-base`}>
                      {entry.title}
                    </Link>
                    <span className="text-muted-foreground">{summaryDetail(entry)}</span>
                    <Link to="/entities/$id/edit" params={{ id: entry.id }} className={linkClass}>
                      Edit this instead
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {query.data.pending.length > 0 && (
            <div>
              <Subheading className="font-medium">Waiting for a moderator</Subheading>
              <ul aria-label="Pending review">
                {query.data.pending.map((entry, i) => (
                  <li key={i} className="flex min-h-11 flex-wrap items-baseline gap-x-3 py-1">
                    <span className="font-serif text-base">{entry.title}</span>
                    <span className="text-muted-foreground">
                      {summaryDetail({
                        mediaType: entry.mediaType ?? undefined,
                        releaseYear: entry.releaseYear ?? undefined,
                      })}
                    </span>
                    <span className="font-medium">Pending review</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
