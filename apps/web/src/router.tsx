import { QueryClient, type DefaultOptions } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import type { ApiClient } from '@amdb/shared/api';
import { RouteError } from './components/route-error';
import { ApiError } from './lib/api';
import type { AuthClient } from './lib/auth';
import { routeTree } from './routeTree.gen';

/** Retries only failures that might pass on a second try: network errors and 5xx, never a 4xx. */
const defaultOptions: DefaultOptions = {
  queries: { retry: (count, error) => count < 3 && !(error instanceof ApiError && error.status < 500) },
};

/**
 * `api` and `auth` are required, never defaulted: main.tsx passes the real clients and tests pass
 * their own, so a test can't fall through to the network by accident.
 */
export function createAppRouter(opts: {
  api: ApiClient;
  auth: AuthClient;
  history?: RouterHistory;
  queryDefaults?: DefaultOptions;
}) {
  const queryClient = new QueryClient({ defaultOptions: opts.queryDefaults ?? defaultOptions });
  return createRouter({
    routeTree,
    history: opts.history,
    context: { api: opts.api, auth: opts.auth, queryClient },
    // Plain words and a Reload button, never the router's developer screen.
    defaultErrorComponent: RouteError,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
