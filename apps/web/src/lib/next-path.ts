/**
 * The page to return to after sign-in. Only a same-origin path survives: the value is resolved
 * against this origin the way a browser would (stripping tabs and newlines, reading `\` as `/`),
 * and anything that lands elsewhere, or on the sign-in page itself, falls back to `/`.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return '/';
  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return '/';
  }
  if (url.origin !== origin || url.pathname === '/sign-in') return '/';
  return url.pathname + url.search + url.hash;
}
