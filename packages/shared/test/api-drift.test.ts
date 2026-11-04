import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const snapshot = fileURLToPath(new URL('../../../apps/api/test/fixtures/openapi.snapshot.json', import.meta.url));
const committed = fileURLToPath(new URL('../src/api/schema.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'amdb-api-schema-'));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// The committed client types must be exactly what `pnpm --filter @amdb/shared gen:api` produces
// from the committed OpenAPI snapshot.
it('schema.ts matches what gen:api generates from the OpenAPI snapshot', () => {
  const out = join(tmp, 'schema.ts');
  const bin = join(pkgDir, 'node_modules', '.bin', 'openapi-typescript');
  execFileSync(bin, [snapshot, '-o', out], { cwd: pkgDir, stdio: 'pipe' });
  expect(readFileSync(committed, 'utf8'), 'run `pnpm --filter @amdb/shared gen:api` and commit the result').toBe(
    readFileSync(out, 'utf8'),
  );
}, 60_000);
