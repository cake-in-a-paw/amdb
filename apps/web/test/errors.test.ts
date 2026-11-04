import { describe, expect, test } from 'vitest';
import { ApiError, unwrap } from '@/lib/api';
import { describeError } from '@/lib/errors';

const failure = (status: number, code: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message: 'api words' } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** What openapi-fetch hands `unwrap`: the parsed error body beside the raw response. */
async function answered(response: Response) {
  return { error: (await response.clone().json()) as unknown, response };
}

/** What `unwrap` throws for an answer. */
async function thrownFor(response: Response) {
  try {
    unwrap(await answered(response));
  } catch (error) {
    return error;
  }
  throw new Error('unwrap did not throw');
}

describe('unwrap', () => {
  test('carries the status and Retry-After on the error it throws', async () => {
    const error = await thrownFor(failure(429, 'rate_limited', { 'retry-after': '90' }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 90 });
  });

  test.each<Record<string, string>>([{}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }])(
    'leaves retryAfterSeconds off when there is no usable header (%o)',
    async (headers) => {
      const error = await thrownFor(failure(429, 'rate_limited', headers));

      expect(error).toMatchObject({ status: 429 });
      expect((error as ApiError).retryAfterSeconds).toBeUndefined();
    },
  );
});

describe('describeError', () => {
  const api = (status: number, code: string, retryAfterSeconds?: number) =>
    new ApiError(status, code, 'api words', undefined, retryAfterSeconds);

  test.each([
    [api(404, 'not_found'), "That doesn't exist, or you can't see it."],
    [api(410, 'removed'), 'This entry was removed.'],
    [
      api(409, 'has_dependents'),
      "Other entries or later changes build on this, so it can't be undone yet. Undo those first.",
    ],
    [api(409, 'already_reverted'), 'This change was already reverted.'],
    [api(429, 'rate_limited'), 'Too many tries. Wait a minute and try again.'],
    [api(429, 'rate_limited', 30), 'Too many tries. Try again in 30 seconds.'],
    [api(429, 'rate_limited', 180), 'Too many tries. Try again in 3 minutes.'],
    [new TypeError('Failed to fetch'), "Couldn't reach AMDB. Check your connection and try again."],
  ])('%s', (error, words) => {
    expect(describeError(error)).toBe(words);
  });

  test('stale_change is explained without its code', () => {
    expect(describeError(api(409, 'stale_change'))).toMatch(/changed this entry in the meantime/);
  });

  test('an unknown code gets the fallback, never the API wording', () => {
    expect(describeError(api(500, 'something_new'))).toBe('Something went wrong. Try again.');
    expect(describeError(api(500, 'something_new'), 'Nope.')).toBe('Nope.');
  });
});
