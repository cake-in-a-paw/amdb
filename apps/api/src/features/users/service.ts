import type { Role } from '@amdb/shared';
import type { DbOrTx } from '../../platform/db/types';
import type { Actor, SessionInfo } from '../../platform/http/app-env';
import { notFound } from '../../platform/http/errors';
import { anonHashOf, isAdmin } from './identity';
import { usersRepository } from './repository';

export function createUsersService(db: DbOrTx, getSession: (headers: Headers) => Promise<SessionInfo | null>) {
  const repo = usersRepository(db);
  return {
    /** A session wins over the anonymous header; a session whose user is gone counts as no one. */
    async resolveActor(headers: Headers): Promise<Actor> {
      const session = await getSession(headers);
      if (session) {
        const role = await repo.findRole(session.userId);
        return role ? { kind: 'user', userId: session.userId, role } : { kind: 'none' };
      }
      const anonHash = anonHashOf(headers.get('x-amdb-anon'));
      return anonHash ? { kind: 'anon', anonHash } : { kind: 'none' };
    },
    /** Admin only; everyone else, and unknown users, get a 404 so the endpoint doesn't show itself. */
    async setRole(actor: Actor, id: string, role: Role) {
      if (!isAdmin(actor)) throw notFound();
      const updated = await repo.setRole(id, role);
      if (!updated) throw notFound();
      return updated;
    },
  };
}
export type UsersService = ReturnType<typeof createUsersService>;
