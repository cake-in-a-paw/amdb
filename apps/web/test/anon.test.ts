import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getAnonToken, rotateAnonToken } from '@/lib/anon';

beforeEach(() => rotateAnonToken());
afterEach(() => vi.restoreAllMocks());

test('the token is created once, stored, and URL-safe at the length the API accepts', () => {
  const token = getAnonToken();

  expect(getAnonToken()).toBe(token);
  expect(localStorage.getItem('amdb.anon')).toBe(token);
  expect(token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
});

test('rotating gives a different token', () => {
  const before = getAnonToken();

  rotateAnonToken();

  const after = getAnonToken();
  expect(after).not.toBe(before);
  expect(localStorage.getItem('amdb.anon')).toBe(after);
});

test('when localStorage throws, the tab still gets one steady token', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });

  const token = getAnonToken();

  expect(token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  expect(getAnonToken()).toBe(token);
  rotateAnonToken();
  expect(getAnonToken()).not.toBe(token);
});
