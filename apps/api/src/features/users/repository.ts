import type { Role } from '@amdb/shared';
import { eq } from 'drizzle-orm';
import { users } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';

const accountColumns = { id: users.id, email: users.email, handle: users.handle, role: users.role };

export function usersRepository(db: DbOrTx) {
  return {
    async findRole(id: string): Promise<Role | null> {
      const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, id));
      return row?.role ?? null;
    },
    async findAccount(id: string) {
      const [row] = await db.select(accountColumns).from(users).where(eq(users.id, id));
      return row ?? null;
    },
    /** Users whose email equals `email`, ignoring case (the column is citext). */
    findByEmail(email: string) {
      return db.select(accountColumns).from(users).where(eq(users.email, email));
    },
    /** Locks every admin row, in id order so concurrent callers can't deadlock; call inside a transaction. */
    async lockAdminIds(): Promise<string[]> {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .orderBy(users.id)
        .for('update');
      return rows.map((r) => r.id);
    },
    async setRole(id: string, role: Role): Promise<{ id: string; role: Role } | null> {
      const [row] = await db
        .update(users)
        .set({ role, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning({ id: users.id, role: users.role });
      return row ?? null;
    },
    async setHandle(id: string, handle: string | null) {
      const [row] = await db
        .update(users)
        .set({ handle, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning(accountColumns);
      return row ?? null;
    },
  };
}
