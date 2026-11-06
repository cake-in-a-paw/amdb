import { z } from '@hono/zod-openapi';
import { ImportRunStatus, ImportSource } from '@amdb/shared';

/** What a run counted. Each importer records its own counts; `{}` while a run hasn't finished. */
export const ImportStats = z.record(z.string(), z.unknown());
export type ImportStats = z.infer<typeof ImportStats>;

export const ImportRunParams = z.object({ id: z.uuid() });

/** An import run, public: the license evidence and parameters behind every change it wrote. */
export const ImportRunSchema = z.object({
  id: z.uuid(),
  source: ImportSource,
  status: ImportRunStatus,
  params: z.record(z.string(), z.unknown()),
  /** The evidence that the source is CC0. */
  licenseUrl: z.string(),
  stats: ImportStats,
  error: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
