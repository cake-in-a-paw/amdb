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
  validateSearch: (raw: Record<string, unknown>): { q?: string } =>
    typeof raw.q === 'string' && raw.q.trim() ? { q: raw.q.trim() } : {},
  component: Search,
});

function Search() {
  const { q } = Route.useSearch();
  const { api } = Route.useRouteContext();
  const results = useInfiniteQuery({
    queryKey: ['search', q],
    enabled: q !== undefined,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      unwrap(
        await api.GET('/api/search', {
          params: { query: { q: q ?? '', cursor: pageParam, limit: PAGE_SIZE } },
          signal,
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  return (
    <div className="max-w-3xl py-8">
      <h1 className="font-serif text-3xl font-semibold">Search</h1>
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
