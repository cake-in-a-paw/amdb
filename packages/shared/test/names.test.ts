import { describe, expect, it } from 'vitest';
import { ALTERNATE_NAMES_MAX, dedupeNames, duplicateNameIndex, joinNorms, normalizeTitle } from '../src';

describe('name rules', () => {
  it('normalizes accents, case and whitespace', () => {
    expect(normalizeTitle('  Ninéteen   EIGHTY-Four ')).toBe('nineteen eighty-four');
  });
  it('caps submitted lists at 50', () => {
    expect(ALTERNATE_NAMES_MAX).toBe(50);
  });
  it('dedupeNames drops title matches and repeats', () => {
    expect(
      dedupeNames(['Nineteen Eighty-Four', null], ['1984', 'nineteen  eighty-four', ' 1984 ', 'Ninéteen Eighty-Four']),
    ).toEqual(['1984']);
  });
  it('duplicateNameIndex finds the first duplicate', () => {
    expect(duplicateNameIndex(['Seven'], ['Se7en', 'SEVEN'])).toBe(1);
    expect(duplicateNameIndex(['Seven'], ['Se7en'])).toBe(-1);
    expect(duplicateNameIndex([undefined], ['A', 'a'])).toBe(1);
  });
  it('joinNorms', () => {
    expect(joinNorms(['Mark Twain', 'Twain'])).toBe('mark twain\ntwain');
    expect(joinNorms([])).toBe('');
  });
});
