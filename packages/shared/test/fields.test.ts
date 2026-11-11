import { describe, expect, it } from 'vitest';
import { CreatorFields, FieldsFor, TagFields, UpdateFieldsFor, WorkFields, WorkFieldsBase } from '../src';

const movie = { mediaType: 'film_tv', subtype: 'movie', title: ' Heat ' } as const;

describe('WorkFields', () => {
  it('trims the title and defaults lifecycle to unknown', () => {
    expect(WorkFields.parse(movie)).toMatchObject({ title: 'Heat', lifecycle: 'unknown' });
  });
  it('requires a subtype for film_tv and forbids one for a book', () => {
    expect(WorkFields.safeParse({ ...movie, subtype: null }).success).toBe(false);
    expect(WorkFields.safeParse({ mediaType: 'book', subtype: 'movie', title: 'Dune' }).success).toBe(false);
    expect(WorkFields.safeParse({ mediaType: 'book', subtype: null, title: 'Dune' }).success).toBe(true);
  });
  it('allows a month only with a year, and a day only with a month valid for it', () => {
    expect(WorkFields.safeParse({ ...movie, releaseMonth: 3 }).success).toBe(false);
    expect(WorkFields.safeParse({ ...movie, releaseYear: 2000, releaseDay: 3 }).success).toBe(false);
    expect(WorkFields.safeParse({ ...movie, releaseYear: 2001, releaseMonth: 2, releaseDay: 29 }).success).toBe(false);
    expect(WorkFields.safeParse({ ...movie, releaseYear: 2000, releaseMonth: 2, releaseDay: 29 }).success).toBe(true);
  });
  it('checks attributes against the media type', () => {
    expect(WorkFields.safeParse({ ...movie, attributes: { runtimeMin: 170 } }).success).toBe(true);
    expect(WorkFields.safeParse({ ...movie, attributes: { pageCount: 300 } }).success).toBe(false);
    expect(
      WorkFields.safeParse({ mediaType: 'book', subtype: null, title: 'Dune', attributes: { pageCount: 600 } }).success,
    ).toBe(true);
  });
  it('rejects empty and over-long titles', () => {
    expect(WorkFields.safeParse({ ...movie, title: '   ' }).success).toBe(false);
    expect(WorkFields.safeParse({ ...movie, title: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('update shape', () => {
  it('does not inject defaults into a partial patch', () => {
    expect(WorkFieldsBase.partial().parse({ title: 'x' })).toEqual({ title: 'x' });
  });
});

describe('other fields', () => {
  it('validates creators and tags', () => {
    expect(CreatorFields.safeParse({ name: 'Michael Mann', kind: 'person' }).success).toBe(true);
    expect(TagFields.safeParse({ kind: 'genre', name: 'Heist', slug: 'Heist!' }).success).toBe(false);
    expect(TagFields.safeParse({ kind: 'genre', name: 'Heist', slug: 'heist' }).success).toBe(true);
  });
  it('has a schema per entity kind', () => {
    expect(Object.keys(FieldsFor).sort()).toEqual(['creator', 'property', 'series', 'tag', 'work']);
  });
});

describe('alternate names', () => {
  it('work fields accept alternateTitles', () => {
    const w = { mediaType: 'book', subtype: null, title: 'X' } as const;
    expect(WorkFields.safeParse({ ...w, alternateTitles: ['Y'] }).success).toBe(true);
    expect(WorkFields.safeParse({ ...w, alternateTitles: [''] }).success).toBe(false);
  });
  it('creator fields accept alternateNames, and updates accept both', () => {
    expect(CreatorFields.safeParse({ name: 'A', kind: 'person', alternateNames: ['B'] }).success).toBe(true);
    expect(CreatorFields.safeParse({ name: 'A', kind: 'person', alternateNames: [' '] }).success).toBe(false);
    expect(UpdateFieldsFor.work.safeParse({ alternateTitles: ['Y'] }).success).toBe(true);
    expect(UpdateFieldsFor.creator.safeParse({ alternateNames: [] }).success).toBe(true);
  });
});
