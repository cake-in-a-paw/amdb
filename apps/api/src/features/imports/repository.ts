import type { ImportRunStatus, ImportSource } from '@amdb/shared';
import { eq } from 'drizzle-orm';
import { importRuns } from '../../platform/db/schema';
import type { DbOrTx } from '../../platform/db/types';

export type ImportRunRow = typeof importRuns.$inferSelect;

export function importsRepository(db: DbOrTx) {
  return {
    async insertRun(run: { source: ImportSource; params: Record<string, unknown>; licenseUrl: string }) {
      const [row] = await db
        .insert(importRuns)
        .values({ ...run, status: 'running' })
        .returning({ id: importRuns.id });
      if (!row) throw new Error('import run insert returned no row');
      return row;
    },

    async finishRun(
      id: string,
      outcome: { status: Exclude<ImportRunStatus, 'running'>; stats: Record<string, unknown>; error: string | null },
    ) {
      await db
        .update(importRuns)
        .set({ ...outcome, finishedAt: new Date() })
        .where(eq(importRuns.id, id));
    },

    async getRun(id: string): Promise<ImportRunRow | null> {
      const [row] = await db.select().from(importRuns).where(eq(importRuns.id, id));
      return row ?? null;
    },
  };
}
