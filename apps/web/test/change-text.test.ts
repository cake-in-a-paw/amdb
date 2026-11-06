import { expect, test } from 'vitest';
import { ageText } from '@/components/queue-item';
import { authorName, valueText } from '@/lib/change-text';

test('a wait reads in its largest whole unit, singular at one', () => {
  expect([0, 59, 60, 119, 120, 3599, 3600, 7200, 86_399, 86_400, 172_800].map(ageText)).toEqual([
    'just now',
    'just now',
    '1 minute',
    '1 minute',
    '2 minutes',
    '59 minutes',
    '1 hour',
    '2 hours',
    '23 hours',
    '1 day',
    '2 days',
  ]);
});

test('an author is a handle, else "contributor", else "anonymous"', () => {
  expect(authorName({ handle: 'ghibli_fan' })).toBe('ghibli_fan');
  expect(authorName({ handle: null })).toBe('contributor');
  expect(authorName('anonymous')).toBe('anonymous');
  expect(authorName({ importRun: { id: 'r', source: 'wikidata' } })).toBe('Wikidata import');
});

test('a value reads as text, null as "cleared", and a long one is cut at 280 characters', () => {
  expect(valueText(null)).toBe('cleared');
  expect(valueText(2016)).toBe('2016');
  expect(valueText({ runtimeMin: 125 })).toBe('{"runtimeMin":125}');
  expect(valueText('x'.repeat(300))).toBe(`${'x'.repeat(280)}…`);
});
