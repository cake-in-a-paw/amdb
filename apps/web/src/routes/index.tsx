import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { EntryRow } from '@/components/entry-row';
import { Button } from '@/components/ui/button';
import { useArt } from '@/lib/art';
import { unwrap } from '@/lib/api';
import { linkClass } from '@/lib/styles';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  return (
    <div className="grid gap-10 py-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-16">
      <section aria-labelledby="intro" className="max-w-prose">
        <h1 id="intro" className="font-serif text-3xl leading-tight font-semibold text-balance">
          An open catalog of films, TV and books
        </h1>
        <p className="mt-4 leading-relaxed text-muted-foreground">
          Anyone can add or correct an entry, and every entry is in the public domain, so you can use the data for
          anything.
        </p>
      </section>
      <CatalogList />
    </div>
  );
}

/** Browse is ordered by title, so this is a first page of the catalog, not a recency list. */
function CatalogList() {
  const { api } = Route.useRouteContext();
  const works = useQuery({
    queryKey: ['browse', 'work', 'home'],
    queryFn: async ({ signal }) =>
      unwrap(await api.GET('/api/browse', { params: { query: { kind: 'work', limit: 20 } }, signal })),
  });
  const art = useArt(
    api,
    (works.data?.items ?? []).map((work) => work.id),
  );

  return (
    <section aria-labelledby="catalog-heading">
      <h2 id="catalog-heading" className="border-b border-border pb-2 font-serif text-xl font-semibold">
        In the catalog
      </h2>
      {works.isPending ? (
        <p role="status" className="py-4 text-muted-foreground">
          Loading the catalog…
        </p>
      ) : works.isError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 py-4">
          <p>Couldn't load the catalog.</p>
          <Button variant="outline" onClick={() => void works.refetch()}>
            Try again
          </Button>
        </div>
      ) : works.data.items.length === 0 ? (
        <div className="py-4">
          <p>The catalog is empty.</p>
          <Link to="/submit" className={linkClass}>
            Add the first entry
          </Link>
        </div>
      ) : (
        <ul aria-labelledby="catalog-heading">
          {works.data.items.map((work) => (
            <EntryRow key={work.id} entry={work} art={art} />
          ))}
        </ul>
      )}
    </section>
  );
}
