import { createApiClient } from '@amdb/shared/api';
import { getAnonToken } from './anon';

/**
 * The anonymous identity header: sent only while signed out, so a signed-in request never carries
 * a token that could be mistaken for its caller. (The claim call is the one exception; it names
 * the token explicitly.)
 */
export function anonHeaders(isSignedIn: () => boolean): Record<string, string> {
  return isSignedIn() ? {} : { 'x-amdb-anon': getAnonToken() };
}

/**
 * The app's client, for main.tsx. Routes get it through router context (`context.api`) so tests
 * can inject their own. `isSignedIn` is asked on every request.
 */
export const createWebApi = (isSignedIn: () => boolean) => createApiClient({ headers: () => anonHeaders(isSignedIn) });

/**
 * A non-2xx answer from the API: the HTTP status, the `{ error: { code, message, details? } }` body
 * and, when the answer had a `Retry-After` header, how many seconds to wait.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(status: number, code: string, message: string, details?: unknown, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** `Retry-After` in seconds. The API sends whole seconds; an HTTP date or junk is ignored. */
function retryAfterSeconds(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function isErrorBody(body: unknown): body is { error: { code: string; message: string; details?: unknown } } {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const inner = body.error;
  return (
    typeof inner === 'object' &&
    inner !== null &&
    'code' in inner &&
    typeof inner.code === 'string' &&
    'message' in inner &&
    typeof inner.message === 'string'
  );
}

/**
 * Returns an openapi-fetch result's data, or throws `ApiError` for an error answer. An answer is an
 * error if it has an error body or is not ok: openapi-fetch reports `error: undefined` for a
 * non-ok answer with an empty body. Missing `data` alone is not an error (a 204 has none).
 */
export function unwrap<T>(res: { data?: T; error?: unknown; response: Response }): T {
  if (res.error !== undefined || !res.response.ok) {
    const { status, statusText } = res.response;
    if (isErrorBody(res.error)) {
      const { code, message, details } = res.error.error;
      throw new ApiError(status, code, message, details, retryAfterSeconds(res.response));
    }
    throw new ApiError(
      status,
      'unknown',
      statusText || `Request failed with status ${status}`,
      res.error,
      retryAfterSeconds(res.response),
    );
  }
  // A 204 (no content) leaves `data` undefined; callers of such endpoints type T as undefined.
  return res.data as T;
}
