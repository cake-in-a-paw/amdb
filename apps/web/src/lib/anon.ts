/** Where the anonymous token lives, and the marker that it was handed to a signed-in account. */
const TOKEN_KEY = 'amdb.anon';
const CLAIMED_KEY = 'amdb.anon.claimed';

/** Used for this tab only when localStorage can't be written (private mode, blocked storage). */
let memoryToken: string | null = null;

/** Runs a storage call; `null` if storage throws, so a broken store never breaks the page. */
function attempt<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** 32 random bytes as 43 base64url characters, inside the API's 32 to 128 URL-safe range. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/** The token if one exists, without creating it. */
export function peekAnonToken(): string | null {
  return attempt(() => localStorage.getItem(TOKEN_KEY)) ?? memoryToken;
}

/** The browser's anonymous identity: created on first use, then the same until rotated. */
export function getAnonToken(): string {
  const existing = peekAnonToken();
  if (existing) return existing;
  const token = newToken();
  if (attempt(() => (localStorage.setItem(TOKEN_KEY, token), true)) === null) memoryToken = token;
  return token;
}

/** Forgets the token; the next `getAnonToken()` makes a new one. Called once a claim succeeds. */
export function rotateAnonToken(): void {
  memoryToken = null;
  attempt(() => localStorage.removeItem(TOKEN_KEY));
  attempt(() => localStorage.removeItem(CLAIMED_KEY));
}

/** Whether `token` was already sent to the claim endpoint. */
export function isClaimed(token: string): boolean {
  return attempt(() => localStorage.getItem(CLAIMED_KEY)) === token;
}

/** Records the claim before it is sent, so a reload or a second tab does not send it twice. */
export function markClaimed(token: string): void {
  attempt(() => localStorage.setItem(CLAIMED_KEY, token));
}

/** Lets a failed claim try again on the next load. */
export function unmarkClaimed(): void {
  attempt(() => localStorage.removeItem(CLAIMED_KEY));
}
