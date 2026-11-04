import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { paths } from '@amdb/shared/api';
import { Button } from '@/components/ui/button';
import { unwrap } from '@/lib/api';

export const Route = createFileRoute('/')({ component: Home });

type Summary = paths['/api/browse']['get']['responses'][200]['content']['application/json']['items'][number];

const mediaTypeLabels: Record<NonNullable<Summary['mediaType']>, string> = {
  film_tv: 'Film & TV',
  book: 'Book',
};

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
          <a
            href="/submit"
            className="mt-2 inline-flex min-h-11 min-w-11 items-center text-primary underline underline-offset-4"
          >
            Add the first entry
          </a>
        </div>
      ) : (
        <ul aria-labelledby="catalog-heading">
          {works.data.items.map((work) => (
            <li key={work.id} className="border-b border-border/70">
              <a
                href={`/entities/${work.id}`}
                className="group flex min-h-11 min-w-11 items-baseline gap-3 py-2.5 hover:bg-secondary/60"
              >
                <span className="font-serif text-lg leading-snug group-hover:underline group-hover:underline-offset-4">
                  {work.title}
                </span>
                <span aria-hidden="true" className="leader flex-1" />
                <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{describe(work)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Film & TV, 2001": the media type and year, as far as they're known. */
function describe(work: Summary) {
  return [work.mediaType && mediaTypeLabels[work.mediaType], work.releaseYear].filter(Boolean).join(', ');
}
