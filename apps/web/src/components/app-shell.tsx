import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useRouterState } from '@tanstack/react-router';
import { cn } from 'cn';
import { ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { SearchBox } from '@/components/search-box';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { meQueryKey, meQueryOptions } from '@/lib/me';

const rootRoute = getRouteApi('__root__');

/** Header and footer links: quiet text, with the 44px floor every control keeps. */
const navLink =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-sm font-medium text-foreground hover:bg-secondary';

/*
 * Moderation is a plain link until its route exists (Task 10); a typed <Link> to a route that
 * isn't there fails tsc.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
          <Link
            to="/"
            aria-label="AMDB home"
            className="inline-flex min-h-11 min-w-11 items-center rounded-md pr-2 font-serif text-2xl font-semibold tracking-tight [font-variation-settings:'opsz'_60]"
          >
            AMDB
          </Link>
          <SearchBox />
          <nav aria-label="Main" className="ml-auto flex flex-wrap items-center justify-end gap-1">
            <Link to="/browse" className={navLink}>
              Browse
            </Link>
            <Link to="/submit" className={navLink}>
              Contribute
            </Link>
            <Session />
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 px-4 py-3 text-sm text-muted-foreground sm:px-6">
          <p>
            All data CC0:{' '}
            <a
              href="https://creativecommons.org/publicdomain/zero/1.0/"
              className={cn(navLink, 'px-0 text-muted-foreground underline underline-offset-4')}
            >
              dedicated to the public domain
            </a>
            . Data dumps coming soon.
          </p>
        </div>
      </footer>
    </div>
  );
}

/** Sign in, or the account menu; moderators and admins also get Moderation. */
function Session() {
  const { api, auth } = rootRoute.useRouteContext();
  const queryClient = useQueryClient();
  const me = useQuery(meQueryOptions(api));
  // Sign-in returns to the page the person was on; the home page and sign-in itself need no `next`.
  const here = useRouterState({ select: (s) => s.location.href });
  const search = here === '/' || here.startsWith('/sign-in') ? {} : { next: here };
  const signOut = useMutation({
    mutationFn: async () => {
      const { error } = await auth.signOut();
      if (error) throw new Error(error.message ?? 'Sign-out failed');
    },
    // Ask the API again rather than assuming: the header shows whoever it says is signed in.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQueryKey }),
  });

  // Reserve the slot while the session loads, so the header doesn't jump.
  if (me.isPending) return <span className="inline-block min-h-11 w-20" aria-hidden="true" />;
  // A failed lookup still leaves a way in; sign-in reports its own errors.
  if (!me.data) {
    return (
      <Link to="/sign-in" search={search} className={navLink}>
        Sign in
      </Link>
    );
  }

  const canModerate = me.data.role === 'moderator' || me.data.role === 'admin';
  return (
    <>
      {canModerate && (
        <a href="/moderation" className={navLink}>
          Moderation
        </a>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="gap-1 px-3">
            Account
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="truncate">{me.data.handle ?? me.data.email}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to="/me/submissions">My submissions</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/account">Account settings</Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={signOut.isPending} onSelect={() => signOut.mutate()}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {signOut.isError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn't sign out. Try again.
        </p>
      )}
    </>
  );
}
