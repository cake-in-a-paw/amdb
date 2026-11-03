import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../../platform/http/app-env';
import type { UsersService } from './service';

/** Sets `c.var.actor` for every request except Better Auth's own routes. */
export function resolveActor(users: UsersService) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    c.set('actor', await users.resolveActor(c.req.raw.headers));
    await next();
  });
}
