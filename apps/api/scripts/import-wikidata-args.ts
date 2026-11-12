// Argument parsing for the import:wikidata CLI, kept free of side effects so tests can import it.
import { CLASSES } from '../src/features/imports/wikidata/discover';

export interface ImportArgs {
  classes: string[];
  minSitelinks: number;
  limit: number;
  maxDbBytes: number;
  dryRun: boolean;
  /** Set only by `--backfill`: add missing references to works already imported (see docs/import.md). */
  backfill?: true;
  /** Set only by `--parts`: import the seasons and episodes of shows AMDB holds (see docs/import.md). */
  parts?: true;
}

/** Flags that choose or update discovered works, which a parts run doesn't do. */
const NOT_WITH_PARTS = ['--backfill', '--classes', '--min-sitelinks'];

const integer = (flag: string, raw: string | undefined, min: number): number => {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw)))
    throw new Error(`${flag} needs ${min === 0 ? 'a non-negative' : 'a positive'} integer (got ${raw ?? 'nothing'})`);
  return Number(raw);
};

export function parseArgs(argv: string[]): ImportArgs {
  const args: ImportArgs = {
    classes: CLASSES.map((c) => c.qid),
    minSitelinks: 5,
    limit: 1000,
    maxDbBytes: 3_500_000_000,
    dryRun: false,
  };
  // The flags given, in order: the defaults fill `classes` and `minSitelinks` either way.
  const given = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== undefined) given.add(flag);
    switch (flag) {
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--backfill':
        args.backfill = true;
        break;
      case '--parts':
        args.parts = true;
        break;
      case '--limit':
        args.limit = integer(flag, argv[++i], 1);
        break;
      case '--max-db-bytes':
        args.maxDbBytes = integer(flag, argv[++i], 1);
        break;
      case '--min-sitelinks':
        args.minSitelinks = integer(flag, argv[++i], 0);
        break;
      case '--classes': {
        const raw = argv[++i];
        const list = (raw ?? '').split(',').map((s) => s.trim());
        const bad = list.filter((q) => !CLASSES.some((c) => c.qid === q));
        if (raw === undefined || bad.length)
          throw new Error(
            `--classes needs a comma list of: ${CLASSES.map((c) => c.qid).join(', ')} (got ${bad.join(', ') || 'nothing'})`,
          );
        args.classes = list;
        break;
      }
      default:
        throw new Error(`Unknown flag ${flag}`);
    }
  }
  const clash = args.parts ? [...given].find((f) => NOT_WITH_PARTS.includes(f)) : undefined;
  if (clash) throw new Error(`--parts can’t be combined with ${clash}: a parts run walks the shows AMDB holds`);
  if (args.dryRun && args.backfill)
    throw new Error('--dry-run and --backfill can’t be combined: a dry run only previews the mapping');
  return args;
}
