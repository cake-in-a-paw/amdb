import { eq } from 'drizzle-orm';
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
