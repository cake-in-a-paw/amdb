import { createRoute, z } from '@hono/zod-openapi';
import { createApi, ErrorSchema, json } from '../../platform/http/openapi';
import { FindUsersQuery, MeSchema, PatchMeBody, SetRoleBody, UserListSchema, UserRoleSchema } from './schemas';
import type { UsersService } from './service';

const setRoleRoute = createRoute({
  method: 'post',
  path: '/api/admin/users/{id}/role',
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: SetRoleBody } }, required: true },
  },
  responses: {
    200: json(UserRoleSchema),
    404: json(ErrorSchema, 'Not found'),
    409: json(ErrorSchema, 'Last admin'),
  },
});

const meRoute = createRoute({
  method: 'get',
  path: '/api/me',
  responses: { 200: json(MeSchema), 401: json(ErrorSchema, 'Not signed in') },
});

const patchMeRoute = createRoute({
  method: 'patch',
  path: '/api/me',
  request: { body: { content: { 'application/json': { schema: PatchMeBody } }, required: true } },
  responses: {
    200: json(MeSchema),
    400: json(ErrorSchema, 'Invalid or reserved handle'),
    401: json(ErrorSchema, 'Not signed in'),
    409: json(ErrorSchema, 'Handle taken'),
  },
});

const findUsersRoute = createRoute({
  method: 'get',
  path: '/api/admin/users',
  request: { query: FindUsersQuery },
  responses: { 200: json(UserListSchema), 404: json(ErrorSchema, 'Not found') },
});

export function usersRoutes(users: UsersService) {
  const app = createApi();
  app.openapi(meRoute, async (c) => c.json(await users.me(c.var.actor), 200));
  app.openapi(patchMeRoute, async (c) => c.json(await users.setHandle(c.var.actor, c.req.valid('json').handle), 200));
  app.openapi(findUsersRoute, async (c) =>
    c.json(await users.findByEmail(c.var.actor, c.req.valid('query').email), 200),
  );
  app.openapi(setRoleRoute, async (c) => {
    const { id } = c.req.valid('param');
    const { role } = c.req.valid('json');
    return c.json(await users.setRole(c.var.actor, id, role), 200);
  });
  return app;
}
