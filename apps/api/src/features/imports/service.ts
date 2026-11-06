import type { ImportSource } from '@amdb/shared';
import type { Db } from '../../platform/db/types';
import { notFound } from '../../platform/http/errors';
import { importsRepository } from './repository';
import type { ImportStats } from './schemas';

export function createImportsService(db: Db) {
  const repo = importsRepository(db);
  return {
    /** Records a run as started; its submissions are written through the changes service's `importSubmission`. */
    async startRun(run: {
      source: ImportSource;
      params: Record<string, unknown>;
      licenseUrl: string;
      /** `YYYY-MM-DD`. */
      licenseCheckedOn: string;
    }) {
      return repo.insertRun(run);
    },

    async finishRun(
      id: string,
      outcome: { status: 'finished' | 'failed' | 'capped'; stats: ImportStats; error?: string },
    ) {
      await repo.finishRun(id, { status: outcome.status, stats: outcome.stats, error: outcome.error ?? null });
    },

    /** The entities already holding these QIDs, so a run can skip present works and reuse references. */
    async findByWikidataIds(qids: string[]) {
      return repo.findByWikidataIds(qids);
    },

    /** Candidates a moderator reverted out of AMDB; a run treats them as present so the revert sticks. */
    async findRetiredWikidataIds(qids: string[]) {
      return repo.findRetiredWikidataIds(qids);
    },

    async databaseBytes() {
      return repo.databaseBytes();
    },

    /** Public: a run is the evidence behind the changes it wrote. */
    async getRun(id: string) {
      const run = await repo.getRun(id);
      if (!run) throw notFound();
      return run;
    },
  };
}
export type ImportsService = ReturnType<typeof createImportsService>;
