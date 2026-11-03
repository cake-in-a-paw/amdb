import { createRoute } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { EntityIdParam, EntitySchema } from './schemas';
import type { CatalogService } from './service';

const getEntityRoute = createRoute({
  method: 'get',
  path: '/api/entities/{id}',
  request: { params: EntityIdParam },
  responses: { 200: json(EntitySchema), 404: json(ErrorSchema, 'Not found') },
});

export function catalogRoutes(catalog: CatalogService) {
  const app = createApi();
  app.openapi(getEntityRoute, async (c) => c.json(await catalog.getEntity(c.req.valid('param').id), 200));
  return app;
}
