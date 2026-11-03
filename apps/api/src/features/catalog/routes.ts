import { createRoute } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { DuplicatesQuery, DuplicatesSchema, EntityIdParam, EntitySchema, SearchQuery, SearchSchema } from './schemas';
import type { CatalogService } from './service';

const getEntityRoute = createRoute({
  method: 'get',
  path: '/api/entities/{id}',
  request: { params: EntityIdParam },
  responses: { 200: json(EntitySchema), 404: json(ErrorSchema, 'Not found') },
});

const searchRoute = createRoute({
  method: 'get',
  path: '/api/search',
  request: { query: SearchQuery },
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
  app.openapi(getEntityRoute, async (c) => c.json(await catalog.getEntity(c.req.valid('param').id), 200));
  app.openapi(searchRoute, async (c) => c.json(await catalog.search(c.req.valid('query')), 200));
  app.openapi(duplicatesRoute, async (c) => c.json(await catalog.duplicates(c.req.valid('query')), 200));
  return app;
}
