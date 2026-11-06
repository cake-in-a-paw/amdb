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

describe('mapWork', () => {
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

  it('skips a missing English label and a 501-character label', () => {
    expect(mapWork({ id: 'Q1', labels: { fr: { value: 'Chose' } } }, FILM, TODAY)).toEqual({ skip: 'no_title' });
    expect(mapWork({ id: 'Q1', labels: { en: { value: 'x'.repeat(501) } } }, FILM, TODAY)).toEqual({
      skip: 'no_title',
    });
    expect('skip' in mapWork({ id: 'Q1', labels: { en: { value: 'x'.repeat(500) } } }, FILM, TODAY)).toBe(false);
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

  it('genreTag strips one trailing suffix and slugs', () => {
    expect(genreTag('science fiction film')).toEqual({ name: 'science fiction', slug: 'science-fiction' });
    expect(genreTag('crime novel')).toEqual({ name: 'crime', slug: 'crime' });
    expect(genreTag("rock 'n' roll television series")).toEqual({ name: "rock 'n' roll", slug: 'rock-n-roll' });
    expect(genreTag('drama')).toEqual({ name: 'drama', slug: 'drama' });
  });
});
