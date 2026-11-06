import { expect, test } from 'vitest';
import { safeNext } from '@/lib/next-path';

test.each([
  ['https://evil.example/x'],
  ['//evil.example/x'],
  ['/\\evil.example/x'],
  ['\\\\evil.example/x'],
  ['/\t/evil.example/x'],
  ['/\n/evil.example/x'],
  ['javascript:alert(1)'],
  ['data:text/html,hi'],
  ['evil.example'],
  ['/sign-in'],
  ['/sign-in?next=/account'],
  [''],
  [null],
  [undefined],
])('%j falls back to the home page', (raw) => {
  expect(safeNext(raw)).toBe('/');
});

test.each([
  ['/account', '/account'],
  ['/me/submissions?page=2#latest', '/me/submissions?page=2#latest'],
  // An encoded slash is a path segment here, not a second origin.
  ['/%2F%2Fevil.example', '/%2F%2Fevil.example'],
  ['/entities/../account', '/account'],
])('%j stays on this site as %j', (raw, kept) => {
  expect(safeNext(raw)).toBe(kept);
});
