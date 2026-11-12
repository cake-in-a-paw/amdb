import type { IdScheme, ImportSource } from '@amdb/shared';
import type { DbOrTx } from '../../platform/db/types';
import { conflict, isUniqueViolation, notFound } from '../../platform/http/errors';
import { importsRepository, type NamesKey } from './repository';
import type { ImportStats } from './schemas';

const alreadyRunning = (id?: string) =>
  conflict(
    'run_in_progress',
    `another import run is already running${id ? ` (${id})` : ''}; wait for it, or see docs/import.md if it died`,
  );

export type { NamesKey };
/** A name list as an import read it, before writing an update that replaces it. */
export type NamesExpectation = { entityId: string; key: NamesKey; names: string[] };

// A transaction too: `importSubmission` runs `assertNamesOpen` inside its own.
export function createImportsService(db: DbOrTx) {
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
      // One run at a time; the partial unique index import_runs_one_running settles a race.
      const running = await repo.findRunning();
      if (running) throw alreadyRunning(running.id);
      try {
        return await repo.insertRun(run);
      } catch (err) {
        if (isUniqueViolation(err)) throw alreadyRunning();
        throw err;
      }
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

    /** QIDs a moderator removed from some entity's wikidata id; a run never adopts an entry for one. */
    async findRemovedWikidataIds(qids: string[]) {
      return repo.findRemovedWikidataIds(qids);
    },

    /** Hand-entered references of `kind` under these normalized names that never held a wikidata id. */
    async findUnlinkedByName(kind: 'creator' | 'series' | 'property', norms: string[]) {
      return repo.findUnlinkedByName(kind, norms);
    },

    /** QIDs a moderator reverted out of AMDB (a work or a reference); a run treats them as taken so the revert sticks. */
    async findRetiredWikidataIds(qids: string[]) {
      return repo.findRetiredWikidataIds(qids);
    },

    /** Of these QIDs, the works an import run created (live, not merged away), by QID: what a backfill may add to. */
    async findImportedWorks(qids: string[]) {
      return repo.findImportedWorks(qids);
    },

    /** Of these QIDs, the creators an import run created (live, not merged away), by QID: what a backfill may name. */
    async findImportedCreators(qids: string[]) {
      return repo.findImportedCreators(qids);
    },

    /** The main names (a work's title and original title, a creator's name) these hold now, by id. */
    async findMainNames(kind: 'work' | 'creator', entityIds: string[]) {
      return repo.findMainNames(kind, entityIds);
    },

    /**
     * The ids among these whose `key` list an import may no longer change: a person or moderator set
     * it, reverted a change that set it, or has a change setting it pending; a create or update on it
     * was redacted; or a merge went into or out of it. A list only import runs set stays open.
     */
    async findNamesBlocked(entityIds: string[], key: NamesKey) {
      return repo.findNamesBlocked(entityIds, key);
    },

    /** The stored name list of each of these works (alternate titles) or creators (alternate names), by id. */
    async findNameLists(kind: 'work' | 'creator', entityIds: string[]) {
      return repo.findNameLists(kind, entityIds);
    },

    /**
     * Inside the transaction that writes an import's names updates: locks the entities, then throws
     * `names_changed` (409) if any is now blocked or its list isn't exactly the one the import read.
     * The lock holds a person's edit off until the import's write commits.
     */
    async assertNamesOpen(expected: NamesExpectation[]): Promise<void> {
      if (expected.length === 0) return;
      const held = await repo.lockAndReadNames([...new Set(expected.map((e) => e.entityId))]);
      const changed = expected.filter(({ entityId, key, names }) => {
        const list = held.get(entityId)?.[key];
        return !list || list.length !== names.length || list.some((n, i) => n !== names[i]);
      });
      for (const key of ['alternateTitles', 'alternateNames'] as const) {
        const ids = expected.filter((e) => e.key === key && !changed.includes(e)).map((e) => e.entityId);
        const blocked = await repo.findNamesBlocked(ids, key);
        changed.push(...expected.filter((e) => e.key === key && blocked.has(e.entityId)));
      }
      if (changed.length > 0) {
        throw conflict('names_changed', 'a name list changed since the import read it', {
          entityIds: [...new Set(changed.map((e) => e.entityId))],
        });
      }
    },

    /** The relations touching these entities, live or removed, so a backfill never re-adds one a moderator took out. */
    async findRelationKeys(entityIds: string[]) {
      return repo.findRelationKeys(entityIds);
    },

    /** Per work, the schemes of every external id it ever had, live or removed. */
    async findExternalIdSchemes(workIds: string[]): Promise<Map<string, Set<IdScheme>>> {
      const out = new Map<string, Set<IdScheme>>();
      for (const { fromId, scheme } of await repo.findExternalIdSchemes(workIds))
        out.set(fromId, (out.get(fromId) ?? new Set()).add(scheme));
      return out;
    },

    /** Keys `scheme:value` of the given ids that a live external id on any entity holds. */
    async findHeldExternalIds(ids: { scheme: IdScheme; value: string }[]): Promise<Set<string>> {
      return new Set((await repo.findHeldExternalIds(ids)).map((i) => `${i.scheme}:${i.value}`));
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
