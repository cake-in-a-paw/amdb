import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupTest } from './helpers/setup';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'amdb-spa-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AMDB</title><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('serves index.html at / and for client-side routes, uncached', async () => {
  const t = await setupTest({ webDistDir: dir });
  try {
    for (const path of ['/', '/entities/8f14e45f-ceea-467a-9575-0c1b8c5d1b4e', '/index.html']) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
      expect(res.headers.get('cache-control'), path).toBe('no-cache');
      expect(await res.text()).toContain('<div id="root">');
    }
  } finally {
    await t.close();
  }
});

it('serves hashed assets with a long immutable cache', async () => {
  const t = await setupTest({ webDistDir: dir });
  try {
    const res = await t.app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log("app")');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // A missing asset is not the app shell.
    expect((await t.app.request('/assets/missing.js')).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('leaves /api alone, and non-GET requests', async () => {
  const t = await setupTest({ webDistDir: dir });
  try {
    const res = await t.app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect((await t.app.request('/api/health')).status).toBe(200);
    expect((await t.app.request('/somewhere', { method: 'POST' })).status).toBe(404);
  } finally {
    await t.close();
  }
});

it('without webDistDir, / is the JSON 404', async () => {
  const t = await setupTest();
  try {
    const res = await t.app.request('/');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  } finally {
    await t.close();
  }
});
