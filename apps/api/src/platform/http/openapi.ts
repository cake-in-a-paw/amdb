import { OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from './app-env';
import { errorBody } from './errors';

export const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

/** Response entry for createRoute. */
export const json = <T extends z.ZodType>(schema: T, description = 'OK') => ({
  description,
  content: { 'application/json': { schema } },
});

export const OkSchema = z.object({ ok: z.literal(true) });

/** OpenAPIHono with our error format for request-validation failures. */
export function createApi() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return c.json(errorBody('invalid_request', 'Invalid request', details), 400);
      }
    },
  });
}

export type Api = ReturnType<typeof createApi>;
