import { expect, it } from 'vitest';
import { setupTest } from './helpers/setup';

it('answers GET /api/health with ok', async () => {
  const t = await setupTest();
  try {
    const res = await t.app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  } finally {
    await t.close();
  }
});

it('answers unknown /api paths with the error shape', async () => {
  const t = await setupTest();
  try {
    const res = await t.app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  } finally {
    await t.close();
  }
});
