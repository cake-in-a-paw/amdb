import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Button } from '@/components/ui/button';
import { renderApp, seed, type SignedInAs } from './harness';

// The floor: every control is at least 44px (Tailwind's 11), has an accessible name, and keeps
// the one base-layer focus ring, so none may switch its outline off.

/** Unprefixed h-*, w-*, size-*, min-h-* and min-w-* classes below 11 (44px). */
function undersized(className: string) {
  return className.split(/\s+/).filter((c) => {
    const m = /^(?:min-)?(?:h|w|size)-(\d+(?:\.\d+)?)$/.exec(c);
    return m?.[1] !== undefined && Number(m[1]) < 11;
  });
}

function expectFloor(control: HTMLElement) {
  const label = control.getAttribute('aria-label') ?? control.textContent ?? '';
  expect(label.trim(), control.outerHTML).not.toBe('');
  expect(control, control.outerHTML).toHaveClass('min-h-11');
  // A second min-w-*/min-h-* is the same CSS property, and Tailwind's order (not the class
  // order) decides which wins, so none may sit beside the 44px floor.
  expect(control.className).not.toMatch(/\bmin-w-(?!11\b)/);
  expect(control.className).not.toMatch(/\bmin-h-(?!11\b)/);
  expect(undersized(control.className)).toEqual([]);
  expect(control.className).not.toMatch(/\boutline-(none|hidden)\b/);
}

describe('accessibility floor in the shell and home page', () => {
  test.each<SignedInAs>(['anonymous', 'contributor', 'moderator'])(
    'every link, button and field has a name and the 44px floor, as %s',
    async (as) => {
      const { user } = await renderApp('/', { as, seed });
      await screen.findByRole('link', { name: /Spirited Away/ });
      if (as === 'anonymous') await screen.findByRole('link', { name: 'Sign in' });
      else await screen.findByRole('button', { name: 'Account' });
      if (as === 'moderator') expect(screen.getByRole('link', { name: 'Moderation' })).toBeInTheDocument();

      const controls = [
        ...screen.getAllByRole('link'),
        ...screen.queryAllByRole('button'),
        screen.getByRole('searchbox', { name: 'Search the catalog' }),
      ];
      for (const control of controls) {
        expectFloor(control);
        // A full-width field already clears the width floor.
        if (control.tagName !== 'INPUT') expect(control, control.outerHTML).toHaveClass('min-w-11');
      }

      if (as === 'anonymous') return;
      // An open menu hides the page from the accessibility tree, so its items are checked alone.
      await user.click(screen.getByRole('button', { name: 'Account' }));
      const items = await screen.findAllByRole('menuitem');
      expect(items.map((i) => i.textContent)).toEqual(['My submissions', 'Account settings', 'Sign out']);
      items.forEach(expectFloor);
    },
  );
});

describe('accessibility floor on the sign-in, account and submissions pages', () => {
  /** Fields are named by a <label>, not text content, so check the computed name. */
  function expectPageFloor(root: HTMLElement) {
    for (const control of within(root).queryAllByRole('textbox')) {
      expect(control).toHaveAccessibleName();
      expect(control).toHaveClass('min-h-11');
    }
    for (const control of [...within(root).queryAllByRole('button'), ...within(root).queryAllByRole('link')]) {
      expectFloor(control);
      expect(control).toHaveClass('min-w-11');
    }
  }

  test('sign-in: both steps', async () => {
    const { user } = await renderApp('/sign-in');
    await screen.findByRole('button', { name: 'Continue with Google' });
    expectPageFloor(screen.getByRole('main'));

    await user.type(screen.getByLabelText('Email'), 'ada@example.test');
    await user.click(screen.getByRole('button', { name: 'Continue with email' }));
    await screen.findByLabelText('Code');
    expectPageFloor(screen.getByRole('main'));
  });

  test('account and my submissions', async () => {
    const t = await renderApp('/account', { as: 'contributor' });
    await screen.findByLabelText('Handle');
    expectPageFloor(screen.getByRole('main'));

    await t.router.navigate({ to: '/me/submissions' });
    await screen.findByText('You haven’t submitted anything yet.');
    expectPageFloor(screen.getByRole('main'));
  });
});

describe('accessibility floor in the shadcn button', () => {
  const sizes = ['default', 'xs', 'sm', 'lg', 'icon', 'icon-xs', 'icon-sm', 'icon-lg'] as const;
  test.each(sizes)('the %s size is at least 44px and keeps its focus outline', (size) => {
    render(
      <Button size={size} aria-label="Save">
        Save
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Save' });
    expectFloor(button);
    expect(button).toHaveClass('min-w-11');
  });
});

describe('focus ring and themes', () => {
  // Read as text: Vitest doesn't run CSS through Tailwind.
  const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');

  test('focus-visible draws a 2px ring in --ring, which is ink, from one base-layer rule', () => {
    expect(css).toMatch(/@layer base\s*\{[\s\S]*:focus-visible\s*\{\s*outline:\s*2px solid var\(--ring\);/);
    expect(css.match(/:focus-visible/g)).toHaveLength(1);
    expect(css).toMatch(/:root\s*\{[^}]*--ring:\s*var\(--ink\);/);
  });

  test('the tokens have a dark set, and dark: utilities follow the same media query', () => {
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[^}]*--paper:/);
    expect(css).toMatch(/@custom-variant dark \(@media \(prefers-color-scheme: dark\)\);/);
  });
});
