import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ApiError, unwrap } from '@/lib/api';
import { describeError, describeSubmitError, existingIdOf } from '@/lib/errors';

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

describe('describeSubmitError', () => {
  const limited = (retryAfterSeconds?: number) =>
    new ApiError(429, 'rate_limited', 'api words', undefined, retryAfterSeconds);

  test.each([
    [limited(3600), 'Too many submissions — try again in 60 minutes'],
    [limited(61), 'Too many submissions — try again in 2 minutes'],
    [limited(30), 'Too many submissions — try again in 1 minute'],
    [limited(), 'Too many submissions — try again later'],
    [new ApiError(409, 'duplicate_slug', 'api words'), 'A tag with that slug already exists.'],
    [new ApiError(409, 'duplicate_external_id', 'api words'), 'That ID is already recorded on another entry.'],
    [new ApiError(400, 'invalid_fields', 'api words'), "Some of this isn't valid. Check it and try again."],
    [new ApiError(500, 'something_new', 'api words'), "Couldn't submit. Try again."],
  ])('%s', (error, words) => {
    expect(describeSubmitError(error)).toBe(words);
  });

  test('identity_required asks to sign in', () => {
    expect(describeSubmitError(new ApiError(400, 'identity_required', 'api words'))).toMatch(/Sign in/);
  });

  test('a duplicate names the entry that already has it', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(existingIdOf(new ApiError(409, 'duplicate_slug', 'x', { existingId: id }))).toBe(id);
    expect(existingIdOf(new ApiError(409, 'duplicate_slug', 'x'))).toBeNull();
    expect(existingIdOf(new TypeError('Failed to fetch'))).toBeNull();
  });
});

describe('every error code the API can send', () => {
  /**
   * Gathered from apps/api/src (`badRequest`, `conflict`, `gone`, `new ApiError`, `errorBody` and
   * the `invalid_request`, `conflict` and `internal` fallbacks in platform/http). A code added to the API goes
   * here too, with its words in describeError, so it can't reach a person as "Try again".
   */
  const codes: [number, string][] = [
    [400, 'invalid_request'],
    [400, 'invalid_fields'],
    [400, 'invalid_relation'],
    [400, 'invalid_role'],
    [400, 'invalid_cursor'],
    [400, 'duplicate_ref'],
    [400, 'unknown_entity'],
    [400, 'unknown_ref'],
    [400, 'unknown_relation'],
    [400, 'edit_out_of_scope'],
    [400, 'handle_reserved'],
    [400, 'identity_required'],
    [400, 'anon_token_required'],
    [401, 'unauthenticated'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [409, 'already_exists'],
    [409, 'already_published'],
    [409, 'already_redacted'],
    [409, 'already_resubmitted'],
    [409, 'already_reverted'],
    [409, 'already_reviewed'],
    [409, 'content_is_current'],
    [409, 'dependency_pending'],
    [409, 'duplicate_external_id'],
    [409, 'duplicate_slug'],
    [409, 'handle_taken'],
    [409, 'has_dependents'],
    [409, 'last_admin'],
    [409, 'not_live'],
    [409, 'not_redactable'],
    [409, 'not_rejected'],
    [409, 'not_revertable'],
    [409, 'redacted'],
    [409, 'stale_change'],
    [410, 'removed'],
    [429, 'rate_limited'],
    [500, 'internal'],
  ];
  /**
   * Codes no screen can meet, so they keep the fallback: edit-and-approve is offered only for a
   * create or update (`not_editable`), the pickers only offer the right kind (`kind_mismatch`), and
   * the web never offers a merge (`self_merge`, `already_merged`, `entity_unavailable`).
   */
  const unreachable = ['not_editable', 'kind_mismatch', 'self_merge', 'already_merged', 'entity_unavailable'];
  const FALLBACK = '<fallback>';

  test.each(codes)('%i %s has its own words', (status, code) => {
    expect(describeError(new ApiError(status, code, 'api words'), FALLBACK)).not.toBe(FALLBACK);
  });

  test.each(unreachable)('%s is unreachable from the UI and listed apart', (code) => {
    expect(codes.map(([, c]) => c)).not.toContain(code);
  });

  test('the list holds every code thrown in apps/api/src', () => {
    const root = fileURLToPath(new URL('../../api/src', import.meta.url));
    const sources = (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((path) => path.endsWith('.ts'))
      .map((path) => readFileSync(join(root, path), 'utf8'));
    const thrown = new Set(
      sources.flatMap((source) =>
        [
          ...source.matchAll(/(?:badRequest|conflict|gone|errorBody)\(\s*'([a-z_]+)'/g),
          ...source.matchAll(/new ApiError\(\s*\d+,\s*'([a-z_]+)'/g),
        ].map((match) => match[1]),
      ),
    );
    expect(thrown.size).toBeGreaterThan(30);
    const listed = new Set([...codes.map(([, code]) => code), ...unreachable]);
    expect([...thrown].filter((code) => !listed.has(code ?? ''))).toEqual([]);
  });
});
