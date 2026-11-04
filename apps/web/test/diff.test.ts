import { expect, test } from 'vitest';
import { diffFields } from '@/lib/diff';

test('only the changed keys come back', () => {
  expect(diffFields({ title: 'A', releaseYear: 2001 }, { title: 'A', releaseYear: 2002 })).toEqual({
    releaseYear: 2002,
  });
});

test('a field that is gone is null, which clears it', () => {
  expect(diffFields({ title: 'A', description: 'x' }, { title: 'A' })).toEqual({ description: null });
});

test('a field that is new comes back as given', () => {
  expect(diffFields({ title: 'A' }, { title: 'A', originalTitle: 'B' })).toEqual({ originalTitle: 'B' });
});

test('nested attributes are compared by value, and sent whole when one differs', () => {
  expect(diffFields({ attributes: { runtimeMin: 90 } }, { attributes: { runtimeMin: 90 } })).toEqual({});
  expect(diffFields({ attributes: { runtimeMin: 90 } }, { attributes: { runtimeMin: 95, episodes: 2 } })).toEqual({
    attributes: { runtimeMin: 95, episodes: 2 },
  });
  expect(diffFields({ attributes: { runtimeMin: 90 } }, {})).toEqual({ attributes: null });
});

test('equal records give nothing', () => {
  expect(diffFields({ subtype: null, title: 'A' }, { subtype: null, title: 'A' })).toEqual({});
});
