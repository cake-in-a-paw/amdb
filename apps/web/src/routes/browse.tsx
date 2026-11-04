import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EntityKind, MediaType } from '@amdb/shared';
import { EmptyList, LoadError, Loading } from '@/components/entity-states';
import { EntryRow } from '@/components/entry-row';
import { LoadMore } from '@/components/load-more';
import { unwrap } from '@/lib/api';
import { PAGE_SIZE } from '@/lib/entity';
import { kindLabels, kindOrder, mediaTypeLabels } from '@/lib/labels';
import { linkClass } from '@/lib/styles';

interface BrowseSearch {
  /** Absent means works. */
  kind?: Exclude<EntityKind, 'work'>;
  /** Only for works. */
  mediaType?: MediaType;
}

export const Route = createFileRoute('/browse')({
  validateSearch: (raw: Record<string, unknown>): BrowseSearch => {
    const kind = EntityKind.safeParse(raw.kind);
    const mediaType = MediaType.safeParse(raw.mediaType);
    if (kind.success && kind.data !== 'work') return { kind: kind.data };
    return mediaType.success ? { mediaType: mediaType.data } : {};
  },
  component: Browse,
});

function Browse() {
  const { kind: otherKind, mediaType } = Route.useSearch();
  const kind: EntityKind = otherKind ?? 'work';
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const list = useInfiniteQuery({
    queryKey: ['browse', kind, mediaType ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/browse', {
          params: { query: { kind, mediaType, cursor: pageParam, limit: PAGE_SIZE } },
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="max-w-3xl py-8">
      <h1 className="font-serif text-3xl font-semibold">Browse</h1>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 border-b border-border">
        <nav aria-label="Browse by kind" className="-mb-px flex flex-wrap gap-x-5">
          {kindOrder.map((k) => (
            <Link
              key={k}
              to="/browse"
              search={k === 'work' ? {} : { kind: k }}
              aria-current={k === kind ? 'page' : undefined}
              className={`${linkClass} ${k === kind ? 'border-b-2 border-foreground font-semibold no-underline text-foreground' : ''}`}
            >
              {kindLabels[k].plural}
            </Link>
          ))}
        </nav>
        {kind === 'work' && (
          <label className="flex items-center gap-2 text-sm">
            Media type
            <select
              value={mediaType ?? ''}
              onChange={(event) => {
                const next = MediaType.safeParse(event.target.value);
                void navigate({ search: next.success ? { mediaType: next.data } : {} });
              }}
              className="min-h-11 min-w-11 rounded-md border border-input bg-card px-2 text-foreground"
            >
              <option value="">All</option>
              {MediaType.options.map((option) => (
                <option key={option} value={option}>
                  {mediaTypeLabels[option]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {list.isPending ? (
        <Loading what="the list" />
      ) : list.isError ? (
        <LoadError what="the list" error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyList />
      ) : (
        <ul aria-label={kindLabels[kind].plural}>
          {items.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
      {list.data && <LoadMore query={list} />}
    </div>
  );
}
