import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('../src', import.meta.url).pathname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const tsFiles = files(src).filter((f) => f.endsWith('.ts'));

/** Import specifiers of a file; relative ones are resolved to a path under `src`. */
const imports = (f: string) =>
  [...readFileSync(f, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => {
    // The regex has one capture group, so it is always present on a match.
    const spec = m[1]!;
    return spec.startsWith('.') ? relative(src, resolve(dirname(f), spec)) : spec;
  });

describe('layering (constitution VIII)', () => {
  it('routes never import drizzle or a repository', () => {
    const bad = tsFiles
      .filter((f) => f.endsWith('/routes.ts'))
      .flatMap((f) =>
        imports(f)
          .filter((i) => i === 'drizzle-orm' || i.startsWith('drizzle-orm/') || i.endsWith('/repository'))
          .map((i) => `${relative(src, f)} → ${i}`),
      );
    expect(bad).toEqual([]);
  });
  it('features never import another feature’s repository or routes', () => {
    const bad = tsFiles
      .filter((f) => relative(src, f).startsWith('features/'))
      .flatMap((f) => {
        const own = relative(src, f).split('/')[1];
        return imports(f)
          .filter((i) => /^features\/([^/]+)\/(repository|routes)$/.test(i) && !i.startsWith(`features/${own}/`))
          .map((i) => `${relative(src, f)} → ${i}`);
      });
    expect(bad).toEqual([]);
  });
  it('platform never imports a feature', () => {
    const bad = tsFiles
      .filter((f) => relative(src, f).startsWith('platform/'))
      .flatMap((f) =>
        imports(f)
          .filter((i) => i.startsWith('features/'))
          .map((i) => `${relative(src, f)} → ${i}`),
      );
    expect(bad).toEqual([]);
  });
});

/** The catalog tables; only the changes feature writes them (constitution VIII). Task 3's tables belong here. */
const CATALOG_TABLES = ['works', 'creators', 'series', 'properties', 'tags', 'relations', 'entities'];

/** Files that may import catalog table objects from the schema. */
const MAY_IMPORT_CATALOG_TABLES = [
  'features/changes/apply.ts',
  'features/changes/repository.ts',
  // Read-only: checked below.
  'features/catalog/repository.ts',
];
const READ_ONLY = ['features/catalog/repository.ts'];

/** Catalog table names a source file imports from `platform/db/schema`, whether named or via a namespace import. */
export function catalogTablesImported(source: string, resolveSpec: (spec: string) => string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/import\s+(?:type\s+)?([^'";]+?)\s+from\s+'([^']+)'/g)) {
    const [, clause = '', spec = ''] = m;
    if (resolveSpec(spec) !== 'platform/db/schema') continue;
    const named = /\{([^}]*)\}/.exec(clause)?.[1];
    if (named === undefined) {
      found.push('*'); // namespace or default import reaches every table
      continue;
    }
    for (const part of named.split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]!; // split always yields an element
      if (CATALOG_TABLES.includes(name)) found.push(name);
    }
  }
  return found;
}

describe('catalog writes (constitution VIII)', () => {
  it('recognizes named, aliased, multi-line and namespace imports of catalog tables', () => {
    const resolve = (spec: string) => (spec === '../platform/db/schema' ? 'platform/db/schema' : spec);
    const source = `
      import { users, works as w,
        type creators } from '../platform/db/schema';
      import * as schema from '../platform/db/schema';
      import { works } from './elsewhere';
    `;
    expect(catalogTablesImported(source, resolve)).toEqual(['works', 'creators', '*']);
  });
  it('only the changes feature imports catalog tables', () => {
    const bad = tsFiles
      .filter((f) => !relative(src, f).startsWith('platform/db/'))
      .filter((f) => !MAY_IMPORT_CATALOG_TABLES.includes(relative(src, f)))
      .flatMap((f) => {
        const resolveSpec = (spec: string) => (spec.startsWith('.') ? relative(src, resolve(dirname(f), spec)) : spec);
        return catalogTablesImported(readFileSync(f, 'utf8'), resolveSpec).map((t) => `${relative(src, f)} → ${t}`);
      });
    expect(bad).toEqual([]);
  });
  it('the catalog repository only reads', () => {
    for (const path of READ_ONLY) {
      const f = join(src, path);
      if (!tsFiles.includes(f)) continue;
      expect(readFileSync(f, 'utf8')).not.toMatch(/\.(insert|update|delete)\(/);
    }
  });
});
