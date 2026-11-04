import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { ApiClient } from '@amdb/shared/api';
import { AnonClaim } from '@/components/anon-claim';
import { AppShell } from '@/components/app-shell';
import type { AuthClient } from '@/lib/auth';

export interface RouterContext {
  /** The typed API client; routes use `context.api` so tests can inject their own. */
  api: ApiClient;
  /** Better Auth sign-in and sign-out; routes use `context.auth` so tests can inject a stub. */
  auth: AuthClient;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({ component: Root, notFoundComponent: NotFound });

function Root() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AnonClaim />
      <AppShell>
        <Outlet />
      </AppShell>
    </QueryClientProvider>
  );
}

function NotFound() {
  return (
    <div className="py-12">
      <h1 className="font-serif text-3xl font-semibold">Not found</h1>
      <p className="mt-3 text-muted-foreground">There's no page at this address.</p>
    </div>
  );
}
