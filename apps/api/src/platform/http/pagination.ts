import { z } from '@hono/zod-openapi';
import { type SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { badRequest } from './errors';

export interface Cursor {
  createdAt: Date;
  id: string;
}

const CursorJson = z.object({ t: z.iso.datetime({ offset: true }), id: z.uuid() });

export const PageQuery = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = CursorJson.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (parsed.success) return { createdAt: new Date(parsed.data.t), id: parsed.data.id };
  } catch {
    // fall through
  }
  throw badRequest('invalid_cursor', 'Invalid cursor');
}

/**
 * Rows strictly older than the cursor, for (ts DESC, id DESC) ordering. `ts` is a timestamptz
 * column or expression (the feed orders by a computed activity time); the cursor's `createdAt`
 * holds that time.
 */
export function cursorBefore(ts: PgColumn | SQL, id: PgColumn, cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${ts}, ${id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

/** Callers fetch limit + 1 rows; the extra row only signals that another page exists. */
export function toPage<T>(rows: T[], limit: number, key: (row: T) => Cursor) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const nextCursor = rows.length > limit && last ? encodeCursor(key(last).createdAt, key(last).id) : null;
  return { items, nextCursor };
}
