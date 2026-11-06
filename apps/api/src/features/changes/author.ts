import type { ImportSource } from '@amdb/shared';

/** The import run that wrote a submission, if one did. */
export interface RunAuthor {
  id: string;
  source: ImportSource;
}

/**
 * The public author of a change: the import run that wrote it, or the user's chosen handle (or
 * none), never their email, name or id, so a contributor without a handle can't have their
 * changes linked together.
 */
export function publicAuthor(userId: string | null, handle: string | null, run: RunAuthor | null) {
  if (run) return { importRun: run };
  return userId ? { handle } : ('anonymous' as const);
}

/** The author as moderators see it: the account id too, so they can follow one contributor's changes. */
export function reviewAuthor(userId: string | null, handle: string | null, run: RunAuthor | null) {
  if (run) return { importRun: run };
  return userId ? { userId, handle } : ('anonymous' as const);
}

/** The run from a row's left-joined `import_runs` columns: both set, or neither. */
export const runOf = (importRunId: string | null, importSource: ImportSource | null): RunAuthor | null =>
  importRunId && importSource ? { id: importRunId, source: importSource } : null;
