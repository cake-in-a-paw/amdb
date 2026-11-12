import { describe, expect, it } from 'vitest';
import { canBePartOf, isPartSubtype, PART_SUBTYPES, ZERO_LAST_SUBTYPES } from '../src/parts';

const ftv = (subtype: 'season' | 'episode' | 'series' | 'anime_series' | 'movie') => ({
  mediaType: 'film_tv' as const,
  subtype,
});

describe('canBePartOf', () => {
  it('lets a season sit under a series', () => expect(canBePartOf(ftv('season'), ftv('series'))).toBe(true));
  it('lets an episode sit under a season or an anime series', () => {
    expect(canBePartOf(ftv('episode'), ftv('season'))).toBe(true);
    expect(canBePartOf(ftv('episode'), ftv('anime_series'))).toBe(true);
  });
  it('refuses a season under a season', () => expect(canBePartOf(ftv('season'), ftv('season'))).toBe(false));
  it('refuses a root subtype as a part', () => expect(canBePartOf(ftv('movie'), ftv('series'))).toBe(false));
  it('refuses a parent of another media type', () =>
    expect(canBePartOf(ftv('episode'), { mediaType: 'book', subtype: null })).toBe(false));
});

describe('part subtypes', () => {
  it('knows which subtypes are parts', () => {
    expect(isPartSubtype('episode')).toBe(true);
    expect(isPartSubtype('series')).toBe(false);
    expect(isPartSubtype(null)).toBe(false);
  });
  it('lists them', () => {
    expect(PART_SUBTYPES).toEqual(['season', 'episode']);
    expect(ZERO_LAST_SUBTYPES).toEqual(['season']);
  });
});
