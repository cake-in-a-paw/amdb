import { createRoute } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import type { Db } from './platform/db/types';
import type { SessionInfo } from './platform/http/app-env';
import { errorBody, handleError, withErrorShape } from './platform/http/errors';
import { createApi, json, OkSchema } from './platform/http/openapi';

export interface AppDeps {
  db: Db;
  /** Returns the caller's session, or null. Production wraps Better Auth; tests read headers. */
  getSession: (headers: Headers) => Promise<SessionInfo | null>;
  /** Better Auth's request handler, mounted at /api/auth/*. Omitted in most tests. */
  authHandler?: (request: Request) => Promise<Response>;
  /** Origin of the web app, for CORS with credentials. */
  webOrigin?: string;
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
        allowHeaders: ['content-type'],
      }),
    );
  }

  if (deps.authHandler) {
    const handler = deps.authHandler;
    app.on(['GET', 'POST'], '/api/auth/*', async (c) => withErrorShape(await handler(c.req.raw)));
  }

  app.openapi(healthRoute, (c) => c.json({ ok: true as const }, 200));

  app.doc('/api/openapi.json', { openapi: '3.0.0', info: { title: 'AMDB API', version: '0.1.0' } });

  return app;
}
