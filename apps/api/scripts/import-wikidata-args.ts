// Argument parsing for the import:wikidata CLI, kept free of side effects so tests can import it.
import { CLASSES } from '../src/features/imports/wikidata/discover';

export interface ImportArgs {
  classes: string[];
  minSitelinks: number;
  limit: number;
  maxDbBytes: number;
  dryRun: boolean;
}

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
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--dry-run':
        args.dryRun = true;
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
  return args;
}
