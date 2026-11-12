import { createRoute, z } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json, RedirectSchema } from '../../platform/http/openapi';
import {
  BrowseQuery,
  DuplicatesQuery,
  DuplicatesSchema,
  EntityIdParam,
  EntitySchema,
  PartsQuery,
  PartsSchema,
  SearchQuery,
  SearchSchema,
} from './schemas';
import type { CatalogService } from './service';

const getEntityRoute = createRoute({
  method: 'get',
  path: '/api/entities/{id}',
  request: { params: EntityIdParam },
  responses: {
    200: json(EntitySchema),
    308: {
      ...json(RedirectSchema, 'The id was merged into another entity; follow `Location`'),
      headers: z.object({ Location: z.string() }),
    },
    404: json(ErrorSchema, 'Not found'),
    410: json(ErrorSchema, 'Removed'),
  },
});

const partsRoute = createRoute({
  method: 'get',
  path: '/api/entities/{id}/parts',
  request: { params: EntityIdParam, query: PartsQuery },
  responses: {
    200: json(PartsSchema, "A work's listed parts, in parts order; anything but a work has none"),
    308: {
      ...json(RedirectSchema, 'The id was merged into another entity; follow `Location`'),
      headers: z.object({ Location: z.string() }),
    },
    400: json(ErrorSchema, 'Invalid query'),
    404: json(ErrorSchema, 'Not found'),
    410: json(ErrorSchema, 'Removed'),
  },
});

const searchRoute = createRoute({
  method: 'get',
  path: '/api/search',
  request: { query: SearchQuery },
  responses: { 200: json(SearchSchema), 400: json(ErrorSchema, 'Invalid query') },
});

const browseRoute = createRoute({
  method: 'get',
  path: '/api/browse',
  request: { query: BrowseQuery },
  responses: { 200: json(SearchSchema), 400: json(ErrorSchema, 'Invalid query') },
});

const duplicatesRoute = createRoute({
  method: 'get',
  path: '/api/duplicates',
  request: { query: DuplicatesQuery },
  responses: { 200: json(DuplicatesSchema), 400: json(ErrorSchema, 'Invalid query') },
});

export function catalogRoutes(catalog: CatalogService) {
  const app = createApi();
  app.openapi(getEntityRoute, async (c) => {
    const entity = await catalog.getEntity(c.req.valid('param').id);
    if ('redirectTo' in entity) {
      return c.json(entity, 308, { Location: `/api/entities/${entity.redirectTo}` });
    }
    return c.json(entity, 200);
  });
  app.openapi(partsRoute, async (c) => {
    const parts = await catalog.parts(c.req.valid('param').id, c.req.valid('query'));
    if ('redirectTo' in parts) {
      return c.json(parts, 308, { Location: `/api/entities/${parts.redirectTo}/parts` });
    }
    return c.json(parts, 200);
  });
  app.openapi(searchRoute, async (c) => c.json(await catalog.search(c.req.valid('query')), 200));
  app.openapi(browseRoute, async (c) => c.json(await catalog.browse(c.req.valid('query')), 200));
  app.openapi(duplicatesRoute, async (c) => c.json(await catalog.duplicates(c.req.valid('query')), 200));
  return app;
}
