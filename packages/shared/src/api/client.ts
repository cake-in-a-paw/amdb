import createClient from 'openapi-fetch';
import type { paths } from './schema';

export type { components, paths } from './schema';

export interface ApiClientOptions {
  /** Prefix for every path. Defaults to the page's origin, so `/api/...` stays same-origin. */
  baseUrl?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Called on every request; the returned headers are added to it (e.g. `x-amdb-anon`). */
  headers?: () => Record<string, string>;
}

/** The typed client for the AMDB API, generated from its OpenAPI snapshot (`gen:api`). */
export function createApiClient(opts: ApiClientOptions = {}) {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl ?? globalThis.location?.origin ?? '',
    credentials: 'same-origin',
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const headers = opts.headers;
  if (headers) {
    client.use({
      onRequest({ request }) {
        for (const [name, value] of Object.entries(headers())) request.headers.set(name, value);
        return request;
      },
    });
  }
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
