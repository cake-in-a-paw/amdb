import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createApp } from '../src/app';
import * as schema from '../src/platform/db/schema';
(async () => {
  // The pool never connects: node-postgres connects on the first query, and serving
  // /api/openapi.json runs none.
  const pool = new pg.Pool();
  const app = createApp({ db: drizzle({ client: pool, schema }), getSession: async () => null });
  const doc = await (await app.request('/api/openapi.json')).json();
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  await pool.end();
})();
