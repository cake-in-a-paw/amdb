import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createApp } from '../src/app';
import * as schema from '../src/platform/db/schema';

it('serves an OpenAPI document that matches the committed snapshot', async () => {
  // The pool never connects: node-postgres connects on the first query, and serving
  // /api/openapi.json runs none.
  const pool = new pg.Pool();
  try {
    const app = createApp({ db: drizzle({ client: pool, schema }), getSession: async () => null });
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const snapshot = JSON.parse(readFileSync(join(__dirname, 'fixtures/openapi.snapshot.json'), 'utf8'));
    expect(await res.json()).toEqual(snapshot);
  } finally {
    await pool.end();
  }
});
