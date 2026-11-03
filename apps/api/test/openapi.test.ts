import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openDb } from '../src/platform/db/open';

it('serves an OpenAPI document that matches the committed snapshot', async () => {
  const { db, close } = await openDb('pglite:memory');
  try {
    const app = createApp({ db, getSession: async () => null });
    const res = await app.request('/api/openapi.json');
    expect(res.status).toBe(200);
    const snapshot = JSON.parse(readFileSync(join(__dirname, 'fixtures/openapi.snapshot.json'), 'utf8'));
    expect(await res.json()).toEqual(snapshot);
  } finally {
    await close();
  }
});
