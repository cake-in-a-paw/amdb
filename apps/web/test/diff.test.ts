import { expect, test } from 'vitest';
import { valueText } from '@/lib/change-text';
import { buildEdit, diffFields } from '@/lib/diff';
import type { EntityView } from '@/lib/entity';
import { formFromEntity } from '@/lib/entity-form';

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

test('a series position written differently but meaning the same number is no change', () => {
  const series = { id: '00000000-0000-4000-8000-000000000002', title: 'Earthsea' };
  // Only what formFromEntity reads: the full view is the API's, and this test needs none of the rest.
  const entity = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'work',
    fields: { mediaType: 'book', subtype: null, title: 'A Wizard of Earthsea' },
    relations: { series: [{ series, position: 3, relationId: '00000000-0000-4000-8000-000000000003' }] },
  } as unknown as EntityView;
  const form = formFromEntity(entity);

  for (const position of ['03', ' 3 ', '3.0']) {
    expect(buildEdit(entity, { ...form, series: form.series.map((s) => ({ ...s, position })) })).toEqual([]);
  }
});

test('equal records give nothing', () => {
  expect(diffFields({ subtype: null, title: 'A' }, { subtype: null, title: 'A' })).toEqual({});
});

test('diff shows lists', () => {
  // A changed list is sent whole; a list emptied is sent as [], not null.
  expect(diffFields({ alternateTitles: ['A'] }, { alternateTitles: ['A', 'B'] })).toEqual({
    alternateTitles: ['A', 'B'],
  });
  expect(diffFields({ alternateTitles: ['A'] }, {})).toEqual({ alternateTitles: [] });
  expect(diffFields({ alternateTitles: ['A'] }, { alternateTitles: ['A'] })).toEqual({});
  // And a list reads as its names joined by ", ".
  expect(valueText(['A', 'B'])).toBe('A, B');
  expect(valueText([])).toBe('cleared');
});
