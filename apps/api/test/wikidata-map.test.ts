import { readFileSync } from 'node:fs';
import { WorkFields } from '@amdb/shared';
import { describe, expect, it } from 'vitest';
import type { Claim, WikidataEntity } from '../src/features/imports/wikidata/client.js';
import type { Candidate } from '../src/features/imports/wikidata/discover.js';
import { genreTag, mapRef, mapWork, type WorkRecord } from '../src/features/imports/wikidata/map.js';

const fixture = (name: string): WikidataEntity =>
  // Fixture JSON is hand-made to the WikidataEntity shape.
  JSON.parse(readFileSync(new URL(`./fixtures/wikidata/${name}.json`, import.meta.url), 'utf8')) as WikidataEntity;

const TODAY = new Date('2026-11-05T12:00:00Z');
const FILM: Candidate = { qid: 'Q100', sitelinks: 50, mediaType: 'film_tv', subtype: 'movie' };
const BOOK: Candidate = { qid: 'Q700', sitelinks: 50, mediaType: 'book', subtype: null };

const time = (t: string, precision: number): Claim => ({
  rank: 'normal',
  mainsnak: { snaktype: 'value', property: 'P577', datavalue: { value: { time: t, precision } } },
});
const withClaims = (claims: Record<string, Claim[]>): WikidataEntity => ({
  id: 'Q1',
  labels: { en: { value: 'Thing' } },
  claims,
});
const ok = (r: ReturnType<typeof mapWork>): WorkRecord => {
  if ('skip' in r) throw new Error('skipped');
  WorkFields.parse(r.fields);
  return r;
};
const fieldsOf = (claims: Record<string, Claim[]>) => ok(mapWork(withClaims(claims), FILM, TODAY)).fields;

const start = (t: string, precision: number): Claim => ({
  rank: 'normal',
  mainsnak: { snaktype: 'value', property: 'P580', datavalue: { value: { time: t, precision } } },
});

describe('mapWork', () => {
  it('falls back to the earliest P580 start time when there is no P577', () => {
    const f = fieldsOf({
      P580: [start('+1995-10-04T00:00:00Z', 11), start('+1994-04-01T00:00:00Z', 11)],
    });
    expect(f).toMatchObject({ releaseYear: 1994, releaseMonth: 4, releaseDay: 1, lifecycle: 'released' });
  });

  it('prefers P577 over P580', () => {
    const f = fieldsOf({
      P577: [time('+2001-05-17T00:00:00Z', 11)],
      P580: [start('+1990-01-01T00:00:00Z', 11)],
    });
    expect(f).toMatchObject({ releaseYear: 2001 });
  });

  it('maps a film fixture', () => {
    const r = ok(mapWork(fixture('film'), FILM, TODAY));
    expect(r.fields).toEqual({
      mediaType: 'film_tv',
      subtype: 'movie',
      title: 'The Test Film',
      originalTitle: "Le Film d'essai",
      description: '1999 test film',
      releaseYear: 1999,
      releaseMonth: 3,
      releaseDay: 31,
      lifecycle: 'released',
      attributes: { runtimeMin: 120 },
    });
    // P58 is deprecated and P50 is a book role, so only director and studio remain.
    expect(r.creators).toEqual([
      { qid: 'Q200', role: 'director' },
      { qid: 'Q202', role: 'studio' },
    ]);
    expect(r.series).toEqual([{ qid: 'Q300', position: 2 }]);
    expect(r.franchises).toEqual(['Q400']);
    expect(r.genres).toEqual(['Q500']);
    expect(r.links).toEqual([
      { qid: 'Q600', linkType: 'adapted_from' },
      { qid: 'Q601', linkType: 'sequel_of' },
    ]);
    expect(r.externalIds).toEqual([
      { scheme: 'wikidata', value: 'Q100' },
      { scheme: 'imdb', value: 'tt0123456' },
    ]);
  });

  it('maps a book: P50 to author, P1104 to pageCount, subtype null', () => {
    const r = ok(mapWork(fixture('book'), BOOK, TODAY));
    expect(r.fields.subtype).toBeNull();
    expect(r.fields.attributes).toEqual({ pageCount: 320 });
    expect(r.creators).toEqual([{ qid: 'Q203', role: 'author' }]);
    expect(r.externalIds).toEqual([
      { scheme: 'wikidata', value: 'Q700' },
      { scheme: 'openlibrary', value: 'OL123W' },
      { scheme: 'isbn13', value: '9780306406157' },
    ]);
  });

  it('release precision: month keeps year and month, decade drops the date, BCE drops the date, earliest of several wins, 31 Feb drops the day', () => {
    expect(fieldsOf({ P577: [time('+2001-05-00T00:00:00Z', 10)] })).toMatchObject({
      releaseYear: 2001,
      releaseMonth: 5,
    });
    expect(fieldsOf({ P577: [time('+2001-05-17T00:00:00Z', 10)] }).releaseDay).toBeUndefined();
    expect(fieldsOf({ P577: [time('+2001-00-00T00:00:00Z', 9)] })).toMatchObject({ releaseYear: 2001 });
    expect(fieldsOf({ P577: [time('+2000-00-00T00:00:00Z', 8)] }).releaseYear).toBeUndefined();
    expect(fieldsOf({ P577: [time('-0300-01-01T00:00:00Z', 11)] }).releaseYear).toBeUndefined();
    expect(fieldsOf({ P577: [time('+2005-06-01T00:00:00Z', 11), time('+2003-02-10T00:00:00Z', 11)] })).toMatchObject({
      releaseYear: 2003,
      releaseMonth: 2,
      releaseDay: 10,
    });
    const feb = fieldsOf({ P577: [time('+2003-02-31T00:00:00Z', 11)] });
    expect(feb).toMatchObject({ releaseYear: 2003, releaseMonth: 2 });
    expect(feb.releaseDay).toBeUndefined();
  });

  it('lifecycle: past → released, future → upcoming, none → unknown', () => {
    expect(fieldsOf({ P577: [time('+2000-01-01T00:00:00Z', 11)] }).lifecycle).toBe('released');
    expect(fieldsOf({ P577: [time('+2030-01-01T00:00:00Z', 11)] }).lifecycle).toBe('upcoming');
    expect(fieldsOf({}).lifecycle).toBe('unknown');
    // The current year straddles today.
    expect(fieldsOf({ P577: [time('+2026-00-00T00:00:00Z', 9)] }).lifecycle).toBe('unknown');
    expect(fieldsOf({ P577: [time('+2026-10-00T00:00:00Z', 10)] }).lifecycle).toBe('released');
    expect(fieldsOf({ P577: [time('+2026-12-00T00:00:00Z', 10)] }).lifecycle).toBe('upcoming');
  });

  it('series link needs a whole-number P1545; "2a" gives no link', () => {
    const series = (ordinal: string | null): Record<string, Claim[]> => ({
      P179: [
        {
          mainsnak: { snaktype: 'value', datavalue: { value: { 'entity-type': 'item', id: 'Q300' } } },
          qualifiers: ordinal ? { P1545: [{ snaktype: 'value', datavalue: { value: ordinal } }] } : {},
        },
      ],
    });
    expect(ok(mapWork(withClaims(series('3')), FILM, TODAY)).series).toEqual([{ qid: 'Q300', position: 3 }]);
    expect(ok(mapWork(withClaims(series('2a')), FILM, TODAY)).series).toEqual([]);
    expect(ok(mapWork(withClaims(series('0')), FILM, TODAY)).series).toEqual([]);
    expect(ok(mapWork(withClaims(series(null)), FILM, TODAY)).series).toEqual([]);
  });

  it('a series position must fit a Postgres integer', () => {
    const series = (ordinal: string): Record<string, Claim[]> => ({
      P179: [
        {
          mainsnak: { snaktype: 'value', datavalue: { value: { 'entity-type': 'item', id: 'Q300' } } },
          qualifiers: { P1545: [{ snaktype: 'value', datavalue: { value: ordinal } }] },
        },
      ],
    });
    expect(ok(mapWork(withClaims(series('2147483647')), FILM, TODAY)).series).toEqual([
      { qid: 'Q300', position: 2147483647 },
    ]);
    expect(ok(mapWork(withClaims(series('2147483648')), FILM, TODAY)).series).toEqual([]);
  });

  it('skips a missing English label and a 501-character label', () => {
    expect(mapWork({ id: 'Q1', labels: { fr: { value: 'Chose' } } }, FILM, TODAY)).toEqual({ skip: 'no_title' });
    expect(mapWork({ id: 'Q1', labels: { en: { value: 'x'.repeat(501) } } }, FILM, TODAY)).toEqual({
      skip: 'no_title',
    });
    expect('skip' in mapWork({ id: 'Q1', labels: { en: { value: 'x'.repeat(500) } } }, FILM, TODAY)).toBe(false);
  });

  it('takes the title from the mul (all-languages) label when there is no en label, en first', () => {
    // Wikidata moved many titles (Forrest Gump, The Matrix) to `mul` and dropped the `en` copy.
    expect(ok(mapWork({ id: 'Q1', labels: { mul: { value: 'The Matrix' } } }, FILM, TODAY)).fields.title).toBe(
      'The Matrix',
    );
    expect(
      ok(mapWork({ id: 'Q1', labels: { en: { value: 'English' }, mul: { value: 'Mul' } } }, FILM, TODAY)).fields.title,
    ).toBe('English');
  });

  it('converts seconds and rejects other units', () => {
    const runtime = (amount: string, unit: string): Record<string, Claim[]> => ({
      P2047: [
        {
          mainsnak: {
            snaktype: 'value',
            datavalue: { value: { amount, unit: `http://www.wikidata.org/entity/${unit}` } },
          },
        },
      ],
    });
    expect(fieldsOf(runtime('+5400', 'Q11574')).attributes).toEqual({ runtimeMin: 90 });
    expect(fieldsOf(runtime('+90', 'Q573')).attributes).toBeUndefined();
  });
});

describe('mapRef and genreTag', () => {
  it('mapRef: Q5 human → person, otherwise organization, null without an English label', () => {
    expect(mapRef(fixture('person'))).toEqual({ name: 'Jane Director', kind: 'person' });
    expect(
      mapRef({ id: 'Q9', labels: { en: { value: 'Acme' } }, descriptions: { en: { value: 'a studio' } } }),
    ).toEqual({
      name: 'Acme',
      kind: 'organization',
      description: 'a studio',
    });
    expect(mapRef({ id: 'Q9', labels: { de: { value: 'Acme' } } })).toBeNull();
  });

  it('mapRef falls back to the mul label', () => {
    expect(mapRef({ id: 'Q9', labels: { mul: { value: 'Robert Zemeckis' } } })?.name).toBe('Robert Zemeckis');
  });

  it('genreTag strips one trailing suffix and slugs', () => {
    expect(genreTag('science fiction film')).toEqual({ name: 'science fiction', slug: 'science-fiction' });
    expect(genreTag('crime novel')).toEqual({ name: 'crime', slug: 'crime' });
    expect(genreTag("rock 'n' roll television series")).toEqual({ name: "rock 'n' roll", slug: 'rock-n-roll' });
    expect(genreTag('drama')).toEqual({ name: 'drama', slug: 'drama' });
  });
});

// Claim builders for the bad-data guards.
const str = (property: string, value: string): Claim => ({
  mainsnak: { snaktype: 'value', property, datavalue: { value } },
});
const qty = (amount: string, unit = '1'): Claim => ({
  mainsnak: { snaktype: 'value', datavalue: { value: { amount, unit } } },
});
const mono = (text: string, language: string): Claim => ({
  mainsnak: { snaktype: 'value', datavalue: { value: { text, language } } },
});
const minutes = (amount: string, unit: string): Claim => qty(amount, `http://www.wikidata.org/entity/${unit}`);
const book = (claims: Record<string, Claim[]>) => ok(mapWork(withClaims(claims), BOOK, TODAY));

describe('mapWork bad-data guards', () => {
  it('isbn13: drops ISBN-10 and garbage, normalizes spaces and hyphens, dedupes', () => {
    const ids = (...v: string[]) => book({ P212: v.map((x) => str('P212', x)) }).externalIds;
    expect(ids('0-306-40615-2', 'not an isbn', '978030640615X')).toEqual([{ scheme: 'wikidata', value: 'Q1' }]);
    expect(ids('978 0 306 40615 7', '978-0-306-40615-7')).toEqual([
      { scheme: 'wikidata', value: 'Q1' },
      { scheme: 'isbn13', value: '9780306406157' },
    ]);
  });

  it('imdb: only tt ids; duplicate ids are deduped', () => {
    const r = book({
      P345: [str('P345', 'nm0000001'), str('P345', 'tt1'), str('P345', 'tt1')],
      P648: [str('P648', 'OL1W'), str('P648', 'OL1W')],
    });
    expect(r.externalIds).toEqual([
      { scheme: 'wikidata', value: 'Q1' },
      { scheme: 'imdb', value: 'tt1' },
      { scheme: 'openlibrary', value: 'OL1W' },
    ]);
  });

  it('tmdb and anilist: positive integers only', () => {
    const r = book({
      P4947: [str('P4947', '603'), str('P4947', '0'), str('P4947', 'abc')],
      P4983: [str('P4983', '1396'), str('P4983', '603x')],
      P8729: [str('P8729', '21'), str('P8729', '21')],
    });
    expect(r.externalIds).toEqual([
      { scheme: 'wikidata', value: 'Q1' },
      { scheme: 'tmdb_movie', value: '603' },
      { scheme: 'tmdb_tv', value: '1396' },
      { scheme: 'anilist', value: '21' },
    ]);
  });

  it('omits a description over 5000 characters (work and mapRef)', () => {
    const long = 'd'.repeat(5001);
    const entity: WikidataEntity = {
      id: 'Q1',
      labels: { en: { value: 'Thing' } },
      descriptions: { en: { value: long } },
    };
    expect(ok(mapWork(entity, FILM, TODAY)).fields.description).toBeUndefined();
    expect(mapRef(entity)).toEqual({ name: 'Thing', kind: 'organization' });
    const edge = { ...entity, descriptions: { en: { value: 'd'.repeat(5000) } } };
    expect(ok(mapWork(edge, FILM, TODAY)).fields.description).toHaveLength(5000);
  });

  it('attributes follow the mediaType', () => {
    expect(fieldsOf({ P1104: [qty('300')] }).attributes).toBeUndefined();
    expect(book({ P1113: [qty('12')] }).fields.attributes).toBeUndefined();
    expect(book({ P2047: [minutes('90', 'Q7727')] }).fields.attributes).toBeUndefined();
    expect(fieldsOf({ P1113: [qty('12')] }).attributes).toEqual({ episodes: 12 });
    expect(book({ P1104: [qty('0')] }).fields.attributes).toBeUndefined();
    expect(book({ P1104: [qty('12.5')] }).fields.attributes).toBeUndefined();
  });

  it('a release year outside 1..9999 drops the date', () => {
    expect(fieldsOf({ P577: [time('+10000-01-01T00:00:00Z', 11)] }).releaseYear).toBeUndefined();
    expect(fieldsOf({ P577: [time('+0000-00-00T00:00:00Z', 9)] }).releaseYear).toBeUndefined();
    expect(fieldsOf({ P577: [time('+9999-01-01T00:00:00Z', 11)] }).releaseYear).toBe(9999);
  });

  it('runtime: rounds to whole minutes; zero, negative and sub-half-minute give none', () => {
    const rt = (amount: string, unit: string) => fieldsOf({ P2047: [minutes(amount, unit)] }).attributes;
    expect(rt('+20', 'Q11574')).toBeUndefined();
    expect(rt('-90', 'Q7727')).toBeUndefined();
    expect(rt('+0', 'Q7727')).toBeUndefined();
    expect(rt('+5430', 'Q11574')).toEqual({ runtimeMin: 91 });
  });

  it('a day-precision date equal to today is unknown', () => {
    expect(fieldsOf({ P577: [time('+2026-11-05T00:00:00Z', 11)] }).lifecycle).toBe('unknown');
    expect(fieldsOf({ P577: [time('+2026-11-04T00:00:00Z', 11)] }).lifecycle).toBe('released');
    expect(fieldsOf({ P577: [time('+2026-11-06T00:00:00Z', 11)] }).lifecycle).toBe('upcoming');
  });

  it('originalTitle skips English, same-as-title and over-long text', () => {
    const orig = (...c: Claim[]) => fieldsOf({ P1476: c }).originalTitle;
    expect(orig(mono('Le Truc', 'en'))).toBeUndefined();
    expect(orig(mono('Thing', 'fr'))).toBeUndefined();
    expect(orig(mono('x'.repeat(501), 'fr'))).toBeUndefined();
    expect(orig(mono('Thing', 'fr'), mono('Chose', 'fr'))).toBe('Chose');
  });

  it('ignores snaks that are not values', () => {
    const noValue: Claim = { mainsnak: { snaktype: 'novalue', property: 'P577' } };
    expect(fieldsOf({ P577: [noValue] }).releaseYear).toBeUndefined();
  });
});

describe('mapRef and genreTag edge cases', () => {
  it('mapRef: a label over 500 characters is null', () => {
    expect(mapRef({ id: 'Q9', labels: { en: { value: 'x'.repeat(501) } } })).toBeNull();
  });

  it('genreTag: other suffixes, one suffix only, punctuation trimmed, empty slug is null', () => {
    expect(genreTag('news television program')).toEqual({ name: 'news', slug: 'news' });
    expect(genreTag('fantasy literature')).toEqual({ name: 'fantasy', slug: 'fantasy' });
    expect(genreTag('war film film')).toEqual({ name: 'war film', slug: 'war-film' });
    expect(genreTag('  (noir)! film')).toEqual({ name: '(noir)!', slug: 'noir' });
    expect(genreTag('аниме')).toBeNull();
    expect(genreTag('аниме film')).toBeNull();
  });
});
