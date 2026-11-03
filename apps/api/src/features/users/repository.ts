import type { Role } from '@amdb/shared';
import { eq } from 'drizzle-orm';
import { users } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';

export function usersRepository(db: DbOrTx) {
  return {
    async findRole(id: string): Promise<Role | null> {
      const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, id));
      return row?.role ?? null;
    },
    async setRole(id: string, role: Role): Promise<{ id: string; role: Role } | null> {
      const [row] = await db
        .update(users)
        .set({ role, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning({ id: users.id, role: users.role });
      return row ?? null;
    },
  };
}
