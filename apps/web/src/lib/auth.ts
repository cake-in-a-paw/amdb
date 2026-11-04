import { queryOptions } from '@tanstack/react-query';
import type { ApiClient } from '@amdb/shared/api';
import { createAuthClient } from 'better-auth/client';
import { ApiError, unwrap } from './api';

/**
 * The part of the Better Auth client the app uses. Routes get it through router context
 * (`context.auth`), so tests pass a stub instead of module-mocking Better Auth.
 */
export interface AuthClient {
  signOut(): Promise<AuthResult>;
}

/**
 * Better Auth's client resolves `{ data, error }` for a failed answer instead of throwing (it still
 * rejects on a network failure), so callers check `error`.
 */
export interface AuthResult {
  data?: unknown;
  error: { code?: string; message?: string; status?: number } | null;
}

/**
 * The app's Better Auth client. Only main.tsx uses it. The API is same-origin (Vite proxies /api in
 * dev), so the base URL is the page's origin; passing it explicitly stops Better Auth from reading
 * a base URL out of the environment.
 */
export const authClient: AuthClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
});

export const meQueryKey = ['me'] as const;

/**
 * Who is signed in, as the API sees it: the account, or `null` when signed out. Browsing is public,
 * so a 401 here is an answer, not an error.
 */
export const meQueryOptions = (api: ApiClient) =>
  queryOptions({
    queryKey: meQueryKey,
    queryFn: async ({ signal }) => {
      try {
        return unwrap(await api.GET('/api/me', { signal }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
