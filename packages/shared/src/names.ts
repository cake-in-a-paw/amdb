/** The form titles and names are matched in: accents stripped, lowercased, whitespace collapsed. */
export const normalizeTitle = (s: string) =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The most alternate names one submission may carry. Merges keep every name, so stored lists have no limit. */
export const ALTERNATE_NAMES_MAX = 50;

/** Index of the first name equal (normalized) to a main title or an earlier name, or -1. Null and undefined mains are ignored. */
export function duplicateNameIndex(main: (string | null | undefined)[], names: string[]): number {
  const seen = new Set(main.filter((m): m is string => typeof m === 'string').map(normalizeTitle));
  for (const [i, name] of names.entries()) {
    const norm = normalizeTitle(name);
    if (seen.has(norm)) return i;
    seen.add(norm);
  }
  return -1;
}

/** The names, trimmed, in order, without any that equals a main title or an earlier name once normalized. */
export function dedupeNames(main: (string | null | undefined)[], names: string[]): string[] {
  const seen = new Set(main.filter((m): m is string => typeof m === 'string').map(normalizeTitle));
  const out: string[] = [];
  for (const name of names) {
    const norm = normalizeTitle(name);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(name.trim());
  }
  return out;
}

/** The normalized names joined by newlines, for matching and search; '' for none. */
export const joinNorms = (names: string[]): string => names.map(normalizeTitle).join('\n');
