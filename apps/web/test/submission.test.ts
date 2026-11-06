import { expect, test } from 'vitest';
import { fieldErrors } from '@/lib/submission';

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
