import { createRoute } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { ImportRunParams, ImportRunSchema } from './schemas';
import type { ImportsService } from './service';

const getRunRoute = createRoute({
  method: 'get',
  path: '/api/import-runs/{id}',
  request: { params: ImportRunParams },
  responses: { 200: json(ImportRunSchema), 404: json(ErrorSchema, 'Not found') },
});

export function importsRoutes(imports: ImportsService) {
  const app = createApi();
  app.openapi(getRunRoute, async (c) => {
    const run = await imports.getRun(c.req.valid('param').id);
    return c.json(
      {
        id: run.id,
        source: run.source,
        status: run.status,
        params: run.params,
        licenseUrl: run.licenseUrl,
        licenseCheckedOn: run.licenseCheckedOn,
        stats: run.stats,
        error: run.error,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      200,
    );
  });
  return app;
}
