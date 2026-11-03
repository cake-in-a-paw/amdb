/** The form titles and names are matched in: accents stripped, lowercased, whitespace collapsed. */
export const normalizeTitle = (s: string) =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
