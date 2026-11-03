import { createRoute, z } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { SetRoleBody, UserRoleSchema } from './schemas';
import type { UsersService } from './service';

const setRoleRoute = createRoute({
  method: 'post',
  path: '/api/admin/users/{id}/role',
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: SetRoleBody } }, required: true },
  },
  responses: { 200: json(UserRoleSchema), 404: json(ErrorSchema, 'Not found') },
});

export function usersRoutes(users: UsersService) {
  const app = createApi();
  app.openapi(setRoleRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { role } = c.req.valid('json');
    return c.json(await users.setRole(c.var.actor, id, role), 200);
  });
  return app;
}
