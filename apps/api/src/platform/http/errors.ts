import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);
export const forbidden = (message = 'You can’t do that') => new ApiError(403, 'forbidden', message);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

const STATUS_CODES: Partial<Record<number, string>> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
};

/**
 * Rewrites an error response from a library handler (Better Auth) into our error shape, keeping
 * its status and headers. A JSON `{ code, message }` body keeps its code, lowercased; a plain-text
 * body becomes the message. Success and redirect responses pass through.
 */
export async function withErrorShape(res: Response): Promise<Response> {
  if (res.status < 400) return res;
  const text = await res.text();
  let parsed: { code?: unknown; message?: unknown } | null = null;
  try {
    // JSON.parse returns `any`; this names only the two fields we probe.
    parsed = JSON.parse(text) as { code?: unknown; message?: unknown } | null;
  } catch {
    // Not JSON: the text itself is the message.
  }
  const code =
    typeof parsed?.code === 'string' && parsed.code
      ? parsed.code.toLowerCase()
      : (STATUS_CODES[res.status] ?? `http_${res.status}`);
  const message =
    typeof parsed?.message === 'string' && parsed.message
      ? parsed.message
      : !parsed && text.trim()
        ? text.trim()
        : res.status === 404
          ? 'Not found'
          : 'Request failed';
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(errorBody(code, message)), { status: res.status, headers });
}

/** Postgres unique violation. Drizzle wraps driver errors, so the code may sit on `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  // Driver errors are untyped; this narrows to just the fields we probe.
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export function handleError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json(errorBody(err.code, err.message, err.details), err.status);
  if (err instanceof HTTPException) {
    const code = err.status === 400 ? 'invalid_request' : `http_${err.status}`;
    // HTTPException.status also allows body-less statuses (204, 304) that c.json's type excludes.
    return c.json(errorBody(code, err.message || 'Invalid request'), err.status as ContentfulStatusCode);
  }
  if (isUniqueViolation(err)) return c.json(errorBody('conflict', 'That already exists'), 409);
  console.error(err);
  return c.json(errorBody('internal', 'Something went wrong'), 500);
}
