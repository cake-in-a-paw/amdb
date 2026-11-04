import { RESERVED_HANDLES, type Role } from '@amdb/shared';
import type { DbOrTx } from '../../platform/db/types';
import type { Actor, SessionInfo } from '../../platform/http/app-env';
import { badRequest, conflict, isUniqueViolation, notFound, unauthenticated } from '../../platform/http/errors';
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
    /** The signed-in user's own account, with the email that no one else sees. */
    async me(actor: Actor) {
      if (actor.kind !== 'user') throw unauthenticated();
      const account = await repo.findAccount(actor.userId);
      if (!account) throw unauthenticated();
      return account;
    },
    /** Sets or clears the public handle (stored lowercase). */
    async setHandle(actor: Actor, handle: string | null) {
      if (actor.kind !== 'user') throw unauthenticated();
      const lowered = handle === null ? null : handle.toLowerCase();
      if (lowered !== null && (RESERVED_HANDLES as readonly string[]).includes(lowered)) {
        throw badRequest('handle_reserved', 'That handle is reserved');
      }
      let updated;
      try {
        updated = await repo.setHandle(actor.userId, lowered);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('handle_taken', 'That handle is taken');
        throw err;
      }
      if (!updated) throw unauthenticated();
      return updated;
    },
    /** Admin only: finds accounts by exact email, for assigning roles. */
    async findByEmail(actor: Actor, email: string) {
      if (!isAdmin(actor)) throw notFound();
      return { items: await repo.findByEmail(email.trim()) };
    },
    /** Admin only; everyone else, and unknown users, get a 404 so the endpoint doesn't show itself. */
    async setRole(actor: Actor, id: string, role: Role) {
      if (!isAdmin(actor)) throw notFound();
      // Demoting yourself is allowed only while another admin remains, so the site always has one.
      if (actor.kind === 'user' && actor.userId === id && role !== 'admin' && (await repo.countOtherAdmins(id)) === 0) {
        throw conflict('last_admin', 'You are the only admin; make someone else an admin first');
      }
      const updated = await repo.setRole(id, role);
      if (!updated) throw notFound();
      return updated;
    },
  };
}
export type UsersService = ReturnType<typeof createUsersService>;
