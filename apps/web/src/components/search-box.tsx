import { useNavigate, useRouterState } from '@tanstack/react-router';
import { SearchIcon } from 'lucide-react';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';

/** The header's search: goes to `/search?q=` through the router, and shows the current query. */
export function SearchBox() {
  const navigate = useNavigate();
  const current = useRouterState({
    select: (s) =>
      s.location.pathname === '/search' && typeof s.location.search.q === 'string' ? s.location.search.q : '',
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    if (q) void navigate({ to: '/search', search: { q } });
  }

  return (
    <form
      role="search"
      onSubmit={submit}
      className="order-last flex w-full gap-2 sm:order-none sm:w-auto sm:max-w-md sm:flex-1"
    >
      {/* Keyed by the URL's query, so a new search page shows what was searched. */}
      <input
        key={current}
        type="search"
        name="q"
        defaultValue={current}
        aria-label="Search the catalog"
        placeholder="Search titles and people"
        className="min-h-11 flex-1 rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground"
      />
      <Button type="submit" variant="outline">
        <SearchIcon aria-hidden="true" />
        Search
      </Button>
    </form>
  );
}
