import { createApiClient } from '@amdb/shared/api';

/** The app's client. Routes get it through router context (`context.api`) so tests can inject their own. */
export const api = createApiClient();

/** A non-2xx answer from the API, carrying its `{ error: { code, message, details? } }` body. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
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
      throw new ApiError(status, code, message, details);
    }
    throw new ApiError(status, 'unknown', statusText || `Request failed with status ${status}`, res.error);
  }
  // A 204 (no content) leaves `data` undefined; callers of such endpoints type T as undefined.
  return res.data as T;
}
