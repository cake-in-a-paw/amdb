import { Button } from '@/components/ui/button';
import { describeError } from '@/lib/errors';

/** The parts of an infinite query that "Load more" needs. */
interface Pager {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  error: unknown;
  fetchNextPage: () => Promise<unknown>;
}

/** Follows the list's cursor one page at a time, and says so if a page fails to load. */
export function LoadMore({ query }: { query: Pager }) {
  if (!query.hasNextPage && !query.isFetchNextPageError) return null;
  return (
    <div className="py-4">
      {query.isFetchNextPageError && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {describeError(query.error)}
        </p>
      )}
      <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
        {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
      </Button>
    </div>
  );
}
