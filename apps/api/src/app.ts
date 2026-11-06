import { createRoute } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { catalogRoutes } from './features/catalog/routes';
import { createCatalogService } from './features/catalog/service';
import { holdAll, type ReviewPolicy } from './features/changes/review-policy';
import { changesRoutes } from './features/changes/routes';
import { createChangesService } from './features/changes/service';
import { importsRoutes } from './features/imports/routes';
import { createImportsService } from './features/imports/service';
import { resolveActor } from './features/users/middleware';
import { usersRoutes } from './features/users/routes';
import { createUsersService } from './features/users/service';
import type { Db } from './platform/db/types';
import type { SessionInfo } from './platform/http/app-env';
import { errorBody, handleError, withErrorShape } from './platform/http/errors';
import { createApi, json, OkSchema } from './platform/http/openapi';
import { serveSpa } from './platform/http/spa';

export interface AppDeps {
  db: Db;
  /** Returns the caller's session, or null. Production wraps Better Auth; tests read headers. */
  getSession: (headers: Headers) => Promise<SessionInfo | null>;
  /** Better Auth's request handler, mounted at /api/auth/*. Omitted in most tests. */
  authHandler?: (request: Request) => Promise<Response>;
  /** Origin of the web app, for CORS with credentials. */
  webOrigin?: string;
  /** Decides whether a new change waits for a moderator or goes live now. Defaults to `holdAll`. */
  reviewPolicy?: ReviewPolicy;
  /** Proxies in front of the API that append to `x-forwarded-for`. Defaults to 1 (Railway's edge). */
  trustedProxyHops?: number;
  /** Directory of the built web app. When set, the API serves it for every non-`/api` GET. */
  webDistDir?: string;
}

const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  responses: { 200: json(OkSchema) },
});

export function createApp(deps: AppDeps) {
  const app = createApi();
  app.onError(handleError);
  app.notFound((c) => c.json(errorBody('not_found', 'Not found'), 404));

  if (deps.webOrigin) {
    app.use(
      '/api/*',
      cors({
        origin: deps.webOrigin,
        credentials: true,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['content-type', 'x-amdb-anon'],
        exposeHeaders: ['Retry-After', 'Location'],
      }),
    );
  }

  if (deps.authHandler) {
    const handler = deps.authHandler;
    app.on(['GET', 'POST'], '/api/auth/*', async (c) => withErrorShape(await handler(c.req.raw)));
  }

  const users = createUsersService(deps.db, deps.getSession);
  app.use('/api/*', resolveActor(users));
  app.route('/', usersRoutes(users));
  app.route(
    '/',
    changesRoutes(createChangesService(deps.db, deps.reviewPolicy ?? holdAll), {
      trustedProxyHops: deps.trustedProxyHops ?? 1,
    }),
  );
  app.route('/', catalogRoutes(createCatalogService(deps.db)));
  app.route('/', importsRoutes(createImportsService(deps.db)));

  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200));

  app.doc('/api/openapi.json', { openapi: '3.0.0', info: { title: 'AMDB API', version: '0.1.0' } });

  // Last, so it only sees what no API route answered.
  if (deps.webDistDir) app.route('/', serveSpa(deps.webDistDir));

  return app;
}
