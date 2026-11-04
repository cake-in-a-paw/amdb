import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { linkClass } from '@/lib/styles';

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="py-6 text-muted-foreground">
      Loading {what}…
    </p>
  );
}

/** A failed load, in words, with a way to try again. */
export function LoadError({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 py-6">
      <p>
        Couldn't load {what}. {describeError(error, '')}
      </p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** A list with nothing in it yet: the way forward is to add the first one. */
export function EmptyList({ children }: { children?: ReactNode }) {
  return (
    <p className="py-6">
      {children ?? 'Nothing here yet — '}
      <Link to="/submit" className={linkClass}>
        add the first one
      </Link>
    </p>
  );
}

export function NotFound() {
  return (
    <div className="py-12">
      <h1 className="font-serif text-3xl font-semibold">Not found</h1>
      <p className="mt-3 text-muted-foreground">There's no entry at this address.</p>
    </div>
  );
}

export function Removed() {
  return (
    <div className="py-12">
      <h1 className="font-serif text-3xl font-semibold">This entry was removed</h1>
      <p className="mt-3 text-muted-foreground">It was taken down for legal or abuse reasons.</p>
    </div>
  );
}

/** The two answers that mean "no entry to show": unknown (or not even an id) and removed. */
export function entryGone(error: unknown): 'not-found' | 'removed' | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 410) return 'removed';
  // A malformed id is rejected as invalid; it can't name an entry either.
  return error.status === 404 || error.status === 400 ? 'not-found' : null;
}
