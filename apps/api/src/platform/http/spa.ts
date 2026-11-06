import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { resolve } from 'node:path';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves the built web app from `dir`: files as they are, hashed ones under `/assets/` cached for
 * a year, and every other path as `index.html` so client-side routes load. Mount it after the API
 * routes; it never answers `/api` or anything but GET and HEAD.
 */
export function serveSpa(dir: string) {
  const root = resolve(dir);
  const app = new Hono();
  const skip = (path: string) => path === '/api' || path.startsWith('/api/');
  // `onFound` runs after the response exists, so the header goes on the response itself.
  const cacheAs = (value: string) => (_path: string, c: Context) => {
    c.res.headers.set('cache-control', value);
  };

  app.use('/assets/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    return serveStatic({
      root,
      onFound: cacheAs(IMMUTABLE),
    })(c, next);
  });
  // Anything else that is a file (index.html, favicon) is served as is, never cached hard.
  app.use('*', async (c, next) => {
    if (skip(c.req.path) || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return next();
    return serveStatic({ root, onFound: cacheAs('no-cache') })(c, next);
  });
  // Unknown paths fall back to the app shell, except missing assets and anything else that names a
  // file (`/favicon.ico`), which are plain 404s. App routes never have a dot: ids are UUIDs.
  const namesFile = (path: string) => /\.[^/]*$/.test(path);
  app.use('*', async (c, next) => {
    if (skip(c.req.path) || c.req.path.startsWith('/assets/') || namesFile(c.req.path)) return next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    return serveStatic({ root, path: 'index.html', onFound: cacheAs('no-cache') })(c, next);
  });
  return app;
}
