import { eq, sql } from 'drizzle-orm';
import { entities } from './schema';
import type { DbOrTx } from './types';

/** Follows `merged_into_id` from `id` to the entity that finally holds its data (`id` itself if it was never merged). */
export async function resolveWinner(db: DbOrTx, id: string): Promise<string> {
  let current = id;
  const seen = new Set<string>();
  for (;;) {
    const [row] = await db.select({ into: entities.mergedIntoId }).from(entities).where(eq(entities.id, current));
    if (!row?.into) return current;
    if (seen.has(current)) throw new Error(`merge cycle at ${current}`);
    seen.add(current);
    current = row.into;
  }
}

/** `id` and every entity merged into it, transitively: the ids whose changes are its history. */
export async function mergeFamily(db: DbOrTx, id: string): Promise<string[]> {
  const rows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      sql`${entities.id} in (with recursive family(id) as (select ${id}::uuid union select e.id from entities e join family f on e.merged_into_id = f.id) select id from family)`,
    );
  return [...new Set([id, ...rows.map((r) => r.id)])];
}
