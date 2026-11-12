import { describe, expect, it } from 'vitest';
import type { Claim, WikidataEntity } from '../src/features/imports/wikidata/client.js';
import {
  claimTo,
  firstValueClaim,
  hasP1545,
  listedPosition,
  ordinal,
  placeEpisodes,
  seasonNumber,
} from '../src/features/imports/wikidata/tree.js';

// Q-ids from the spec: Q1079 Breaking Bad, Q1582890 its season 1, Q14625947 its pilot episode.
const SHOW = 'Q1079';
const SEASON = 'Q1582890';
const EPISODE = 'Q14625947';

/** An item-valued claim, optionally with a `P1545` ordinal qualifier. */
const rel = (qid: string, ord?: string, rank = 'normal'): Claim => ({
  rank,
  mainsnak: { snaktype: 'value', datavalue: { value: { 'entity-type': 'item', id: qid } } },
  ...(ord === undefined ? {} : { qualifiers: { P1545: [{ snaktype: 'value', datavalue: { value: ord } }] } }),
});
const entity = (id: string, claims: Record<string, Claim[]> = {}): WikidataEntity => ({
  id,
  labels: { en: { value: id } },
  claims,
});

describe('claim helpers', () => {
  it('claimTo finds the claim to the target, preferred rank first, never deprecated', () => {
    const e = entity('Q1', { P179: [rel('Q9', '1', 'deprecated'), rel('Q9', '2'), rel('Q9', '3', 'preferred')] });
    expect(ordinal(claimTo(e, 'P179', 'Q9')!)).toBe(3);
    expect(claimTo(entity('Q1', { P179: [rel('Q9', '1', 'deprecated')] }), 'P179', 'Q9')).toBeNull();
    expect(claimTo(e, 'P179', 'Q8')).toBeNull();
  });

  it('firstValueClaim prefers the preferred rank and skips non-values', () => {
    const none: Claim = { rank: 'preferred', mainsnak: { snaktype: 'novalue' } };
    const e = entity('Q1', { P4908: [none, rel('Q5'), rel('Q6', undefined, 'preferred')] });
    expect(firstValueClaim(e, 'P4908')?.mainsnak.datavalue?.value).toMatchObject({ id: 'Q6' });
    expect(firstValueClaim(entity('Q1', { P4908: [none] }), 'P4908')).toBeNull();
  });

  it('hasP1545 is true for any P1545 qualifier, whatever its value', () => {
    expect(hasP1545(rel('Q9', '1a'))).toBe(true);
    expect(hasP1545(rel('Q9'))).toBe(false);
  });

  it('listedPosition reads the parent P527 claim to the child', () => {
    expect(listedPosition(entity(SHOW, { P527: [rel(SEASON, '1')] }), SEASON)).toEqual({ listed: true, position: 1 });
    expect(listedPosition(entity(SHOW, { P527: [rel(SEASON)] }), SEASON)).toEqual({ listed: true, position: null });
    expect(listedPosition(entity(SHOW), SEASON)).toEqual({ listed: false, position: null });
    expect(listedPosition(undefined, SEASON)).toEqual({ listed: false, position: null });
  });
});

describe('seasonNumber', () => {
  it("season number from P179 qualifier, else the show's P527", () => {
    expect(seasonNumber(entity(SEASON, { P179: [rel(SHOW, '1')] }), SHOW, undefined)).toBe(1);
    const show = entity(SHOW, { P527: [rel(SEASON, '1')] });
    expect(seasonNumber(entity(SEASON, { P179: [rel(SHOW)] }), SHOW, show)).toBe(1);
  });

  it("child's ordinal wins over the parent's list", () => {
    const show = entity(SHOW, { P527: [rel(SEASON, '3')] });
    expect(seasonNumber(entity(SEASON, { P179: [rel(SHOW, '2')] }), SHOW, show)).toBe(2);
  });

  it('non-whole ordinal gives no position', () => {
    const show = entity(SHOW, { P527: [rel(SEASON, '1')] });
    expect(seasonNumber(entity(SEASON, { P179: [rel(SHOW, '1a')] }), SHOW, show)).toBeNull();
    expect(ordinal(rel(SHOW, '1a'))).toBeNull();
  });

  it('season 0 is kept', () => {
    expect(seasonNumber(entity(SEASON, { P179: [rel(SHOW, '0')] }), SHOW, undefined)).toBe(0);
  });

  it('ordinal past the integer range is null', () => {
    expect(ordinal(rel(SHOW, '2147483647'))).toBe(2147483647);
    expect(ordinal(rel(SHOW, '2147483648'))).toBeNull();
  });
});

describe('placeEpisodes', () => {
  const base = {
    showQid: SHOW,
    seasonsOfShow: new Map<string, WikidataEntity>(),
    placedSeasons: new Set<string>(),
    showHasSeasonParts: false,
  };

  it('episode under its P4908 season', () => {
    const season = entity(SEASON, { P179: [rel(SHOW, '1')] });
    const ep = entity(EPISODE, { P4908: [rel(SEASON, '1')], P179: [rel(SHOW, '1')] });
    expect(
      placeEpisodes({
        ...base,
        seasonsOfShow: new Map([[SEASON, season]]),
        placedSeasons: new Set([SEASON]),
        episodes: [ep],
      }),
    ).toEqual({ placed: [{ qid: EPISODE, parentQid: SEASON, position: 1 }], unplaced: [] });
  });

  it("episode under its P4908 season with no qualifier takes the season's P527 position", () => {
    const season = entity(SEASON, { P527: [rel(EPISODE, '5')] });
    const ep = entity(EPISODE, { P4908: [rel(SEASON)] });
    expect(
      placeEpisodes({
        ...base,
        seasonsOfShow: new Map([[SEASON, season]]),
        placedSeasons: new Set([SEASON]),
        episodes: [ep],
      }).placed,
    ).toEqual([{ qid: EPISODE, parentQid: SEASON, position: 5 }]);
  });

  it("episode found by the season's P527", () => {
    const season = entity(SEASON, { P527: [rel(EPISODE, '4')] });
    expect(
      placeEpisodes({
        ...base,
        seasonsOfShow: new Map([[SEASON, season]]),
        placedSeasons: new Set([SEASON]),
        episodes: [entity(EPISODE, { P179: [rel(SHOW)] })],
      }),
    ).toEqual({ placed: [{ qid: EPISODE, parentQid: SEASON, position: 4 }], unplaced: [] });
  });

  it('episode of a seasonless show by overall number', () => {
    expect(placeEpisodes({ ...base, episodes: [entity(EPISODE, { P179: [rel(SHOW, '47')] })] })).toEqual({
      placed: [{ qid: EPISODE, parentQid: SHOW, position: 47 }],
      unplaced: [],
    });
  });

  it("episode whose P4908 season is another show's is unplaced", () => {
    const ep = entity(EPISODE, { P4908: [rel('Q999', '1')], P179: [rel(SHOW, '1')] });
    expect(placeEpisodes({ ...base, episodes: [ep] })).toEqual({ placed: [], unplaced: [EPISODE] });
  });

  it("episode whose P4908 season is the show's but not placed falls through to the later steps", () => {
    const other = 'Q1582891';
    const skipped = entity(SEASON, { P527: [rel(EPISODE, '2')] });
    const ep = entity(EPISODE, { P4908: [rel(SEASON, '2')] });
    const seasonsOfShow = new Map([[SEASON, skipped]]);
    // No other placed season lists it, and the show has seasons: unplaced.
    expect(placeEpisodes({ ...base, seasonsOfShow, episodes: [ep] })).toEqual({ placed: [], unplaced: [EPISODE] });
    // The one placed season that lists it takes it, with that season's position.
    seasonsOfShow.set(other, entity(other, { P527: [rel(EPISODE, '7')] }));
    expect(placeEpisodes({ ...base, seasonsOfShow, placedSeasons: new Set([other]), episodes: [ep] })).toEqual({
      placed: [{ qid: EPISODE, parentQid: other, position: 7 }],
      unplaced: [],
    });
  });

  it('episode in a show with seasons but none listing it is unplaced', () => {
    const ep = entity(EPISODE, { P179: [rel(SHOW, '3')] });
    expect(
      placeEpisodes({
        ...base,
        seasonsOfShow: new Map([[SEASON, entity(SEASON)]]),
        placedSeasons: new Set([SEASON]),
        episodes: [ep],
      }),
    ).toEqual({ placed: [], unplaced: [EPISODE] });
    // A season already in AMDB under the show blocks the seasonless fallback too.
    expect(placeEpisodes({ ...base, showHasSeasonParts: true, episodes: [ep] })).toEqual({
      placed: [],
      unplaced: [EPISODE],
    });
  });

  it('two seasons listing one episode is unplaced', () => {
    const other = 'Q1582891';
    expect(
      placeEpisodes({
        ...base,
        seasonsOfShow: new Map([
          [SEASON, entity(SEASON, { P527: [rel(EPISODE, '1')] })],
          [other, entity(other, { P527: [rel(EPISODE, '1')] })],
        ]),
        placedSeasons: new Set([SEASON, other]),
        episodes: [entity(EPISODE)],
      }),
    ).toEqual({ placed: [], unplaced: [EPISODE] });
  });
});
