import { createRoute } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { clientIp, rateLimit } from '../../platform/http/rate-limit';
import { ArtQuery, ArtSchema } from './schemas';
import type { ArtService } from './service';

/** Requests per address per minute: keeps one client from spending a source's limit for everyone. */
const PER_IP_LIMIT = 120;

const artRoute = createRoute({
  method: 'get',
  path: '/api/art',
  description:
    'Art for works, linked live from TMDB, Open Library or AniList. A display aid, not dataset data: unmetered, never stored.',
  request: { query: ArtQuery },
  responses: {
    200: json(ArtSchema),
    400: json(ErrorSchema, 'Invalid query: not 1 to 50 work ids'),
    429: json(ErrorSchema, 'Rate limited'),
  },
});

export function artRoutes(art: ArtService, { trustedProxyHops }: { trustedProxyHops: number }) {
  const app = createApi();
  app.use(
    '/api/art',
    rateLimit({
      key: (c) => `ip:${clientIp(c, trustedProxyHops) ?? 'unknown'}`,
      limit: PER_IP_LIMIT,
      windowMs: 60_000,
    }),
  );
  app.openapi(artRoute, async (c) => c.json({ items: await art.art(c.req.valid('query').works.split(',')) }, 200));
  return app;
}
