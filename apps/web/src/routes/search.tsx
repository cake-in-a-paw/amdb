import { useInfiniteQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { EntityKind } from '@amdb/shared';
import { EntryRow } from '@/components/entry-row';
import { LoadError, Loading } from '@/components/entity-states';
import { LoadMore } from '@/components/load-more';
import { unwrap } from '@/lib/api';
import { PAGE_SIZE, type Summary } from '@/lib/entity';
import { kindLabels, kindOrder } from '@/lib/labels';
import { linkClass } from '@/lib/styles';

export const Route = createFileRoute('/search')({
  validateSearch: (raw: Record<string, unknown>): { q?: string; parts?: true } => ({
    ...(typeof raw.q === 'string' && raw.q.trim() ? { q: raw.q.trim() } : {}),
    // The router parses `?parts=true` as the boolean; a hand-typed string is taken too.
    ...(raw.parts === true || raw.parts === 'true' ? { parts: true as const } : {}),
  }),
  component: Search,
});

function Search() {
  const { q, parts } = Route.useSearch();
  const { api } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const results = useInfiniteQuery({
    queryKey: ['search', q, parts === true],
    enabled: q !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/search', {
          params: {
            query: {
              q: q ?? '',
              cursor: pageParam,
              limit: PAGE_SIZE,
              ...(parts ? { includeParts: 'true' as const } : {}),
            },
          },
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  return (
    <div className="max-w-3xl py-8">
      <h1 className="font-serif text-3xl font-semibold">Search</h1>
      <label className="mt-3 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={parts === true}
          onChange={(e) => {
            const include = e.target.checked;
            void navigate({
              search: (prev) => (include ? { ...prev, parts: true } : prev.q ? { q: prev.q } : {}),
            });
          }}
          className="size-4"
        />
        Include seasons and episodes
      </label>
      {q === undefined ? (
        <p className="py-4 text-muted-foreground">Type a title or a name to search.</p>
      ) : results.isPending ? (
        <Loading what="results" />
      ) : results.isError && !results.data ? (
        <LoadError what="results" error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <Results q={q} items={results.data.pages.flatMap((page) => page.items)} />
      )}
      {q !== undefined && results.data && <LoadMore query={results} />}
    </div>
  );
}

function Results({ q, items }: { q: string; items: Summary[] }) {
  if (items.length === 0) {
    return (
      <div className="py-4">
        <p>No results for “{q}”.</p>
        <Link to="/submit" search={{ title: q }} className={linkClass}>
          Add it
        </Link>
      </div>
    );
  }
  return (
    <>
      {kindOrder.map((kind) => (
        <KindGroup key={kind} kind={kind} items={items.filter((item) => item.kind === kind)} />
      ))}
    </>
  );
}

function KindGroup({ kind, items }: { kind: EntityKind; items: Summary[] }) {
  if (items.length === 0) return null;
  const headingId = `search-${kind}`;
  return (
    <section aria-labelledby={headingId} className="mt-6">
      <h2 id={headingId} className="border-b border-border pb-2 font-serif text-xl font-semibold">
        {kindLabels[kind].plural}
      </h2>
      <ul aria-labelledby={headingId}>
        {items.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}
