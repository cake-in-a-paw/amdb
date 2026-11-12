import { expect, test } from 'vitest';
import { emptyForm, fieldErrors, isEntryForm, upgradeForm, validateForm, type EntryForm } from '@/lib/submission';

const film = { mediaType: 'film_tv', subtype: 'movie', title: 'Arrival' };

test('a number field that is out of range asks for a whole number, on its own input', () => {
  expect(fieldErrors('work', { ...film, runtimeMin: '-5' })).toEqual({ runtimeMin: 'Use a whole number above 0.' });
  expect(fieldErrors('work', { ...film, episodes: '1.5' })).toEqual({ episodes: 'Use a whole number above 0.' });
  expect(fieldErrors('work', { mediaType: 'book', title: 'Kindred', pageCount: '0' })).toEqual({
    pageCount: 'Use a whole number above 0.',
  });
});

test('a field that is not a number is never told to use a whole number', () => {
  expect(fieldErrors('work', { ...film, lifecycle: 'someday' })).toEqual({ lifecycle: 'Choose a release status.' });
});

const episode = (position: string): EntryForm => ({
  ...emptyForm(),
  fields: { mediaType: 'film_tv', subtype: 'episode', title: 'Pilot' },
  parent: [{ entity: { id: '00000000-0000-4000-8000-000000000001', title: 'Season 1' }, position }],
});

test("a part's number is blank or a whole number from 0 to 2147483647", () => {
  for (const ok of ['', '  ', '0', '3', '2147483647']) expect(validateForm(episode(ok))).toEqual({});
  for (const bad of ['-1', '2147483648', '1.5', 'one']) {
    expect(validateForm(episode(bad))).toEqual({ 'parent.0.position': 'Use a whole number from 0 to 2147483647.' });
  }
});

test('upgradeForm gives a form saved before parts an empty parent, and leaves anything else as it is', () => {
  const { parent: _, ...old } = emptyForm();
  expect(isEntryForm(old)).toBe(false);
  expect(upgradeForm(old)).toEqual(emptyForm());
  expect(isEntryForm(upgradeForm(old))).toBe(true);
  const current = episode('1');
  expect(upgradeForm(current)).toBe(current);
  expect(upgradeForm(null)).toBe(null);
});
