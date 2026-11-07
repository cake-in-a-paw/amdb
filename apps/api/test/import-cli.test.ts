import { describe, expect, it } from 'vitest';
import { parseArgs } from '../scripts/import-wikidata-args';

const ALL = ['Q20650540', 'Q63952888', 'Q11424', 'Q5398426', 'Q7725634'];

describe('import:wikidata parseArgs', () => {
  it('defaults', () => {
    expect(parseArgs([])).toEqual({
      classes: ALL,
      minSitelinks: 5,
      limit: 1000,
      maxDbBytes: 3_500_000_000,
      dryRun: false,
    });
  });

  it('reads every flag', () => {
    expect(
      parseArgs([
        '--limit',
        '50',
        '--classes',
        'Q11424,Q7725634',
        '--max-db-bytes',
        '1000',
        '--min-sitelinks',
        '0',
        '--dry-run',
      ]),
    ).toEqual({ classes: ['Q11424', 'Q7725634'], minSitelinks: 0, limit: 50, maxDbBytes: 1000, dryRun: true });
  });

  it('reads --backfill, and refuses it with --dry-run (a dry run only previews the mapping)', () => {
    expect(parseArgs(['--backfill', '--limit', '10'])).toMatchObject({ backfill: true, dryRun: false, limit: 10 });
    expect(() => parseArgs(['--dry-run', '--backfill'])).toThrow(/--dry-run.*--backfill|--backfill.*--dry-run/);
    expect(() => parseArgs(['--backfill', '--dry-run'])).toThrow(/--dry-run.*--backfill|--backfill.*--dry-run/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/--bogus/);
  });

  it.each([
    [['--limit', 'abc']],
    [['--limit', '0']],
    [['--limit', '1.5']],
    [['--limit']],
    [['--max-db-bytes', '-1']],
    [['--min-sitelinks', '-1']],
    [['--min-sitelinks', 'x']],
  ])('rejects a bad number %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(/--/);
  });

  it('rejects an unknown class', () => {
    expect(() => parseArgs(['--classes', 'Q11424,Q1'])).toThrow(/Q1/);
    expect(() => parseArgs(['--classes', 'film'])).toThrow(/film/);
  });
});
