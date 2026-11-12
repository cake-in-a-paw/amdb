import { describe, expect, test } from 'vitest';
import type { Summary } from '@/lib/entity';
import { type Ancestor, partLabel, partTitle } from '@/lib/parts';

const show: Ancestor = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Breaking Bad',
  subtype: 'series',
  removed: false,
};
const season = (position?: number): Ancestor => ({
  id: '00000000-0000-4000-8000-000000000002',
  title: 'Breaking Bad',
  subtype: 'season',
  ...(position === undefined ? {} : { position }),
  removed: false,
});

describe('partLabel', () => {
  test('a season is numbered, and 0 is Specials', () => {
    expect(partLabel('season', 2, [show])).toBe('Season 2');
    expect(partLabel('season', 0, [show])).toBe('Specials');
  });

  test('an episode under a numbered season is S{S}E{N}', () => {
    expect(partLabel('episode', 14, [show, season(2)])).toBe('S2E14');
  });

  test('an episode directly under a show is Episode N', () => {
    expect(partLabel('episode', 5, [show])).toBe('Episode 5');
  });

  test('a season and an episode at 3 directly under a show', () => {
    expect(partLabel('season', 3, [show])).toBe('Season 3');
    expect(partLabel('episode', 3, [show])).toBe('Episode 3');
  });

  test('with no position', () => {
    expect(partLabel('season', undefined, [show])).toBe('Season');
    expect(partLabel('episode', undefined, [show, season(2)])).toBe('S2E?');
    expect(partLabel('episode', undefined, [show])).toBe('Episode');
  });

  test('an episode under an unnumbered season is numbered as an episode', () => {
    expect(partLabel('episode', 4, [show, season()])).toBe('Episode 4');
  });

  test('anything else has no label', () => {
    expect(partLabel('movie', 1, [])).toBe('');
    expect(partLabel(null, undefined, [])).toBe('');
  });
});

describe('partTitle', () => {
  const summary = (title: string, part?: Summary['part']): Summary => ({
    id: '00000000-0000-4000-8000-000000000003',
    kind: 'work',
    title,
    mediaType: 'film_tv',
    ...(part ? { part } : {}),
  });

  test('an episode reads root · label · title', () => {
    expect(partTitle(summary('Pilot', { subtype: 'episode', position: 1, ancestors: [show, season(1)] }))).toBe(
      'Breaking Bad · S1E1 · Pilot',
    );
  });

  test('a season reads root · label', () => {
    expect(partTitle(summary('Breaking Bad Season 2', { subtype: 'season', position: 2, ancestors: [show] }))).toBe(
      'Breaking Bad · Season 2',
    );
  });

  test('a film is its title', () => {
    expect(partTitle(summary('Pilot'))).toBe('Pilot');
  });

  test('a removed root is left out', () => {
    expect(
      partTitle(
        summary('Pilot', { subtype: 'episode', position: 1, ancestors: [{ ...show, removed: true }, season(1)] }),
      ),
    ).toBe('S1E1 · Pilot');
  });
});
