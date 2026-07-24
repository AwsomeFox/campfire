/**
 * Player Display cast-control a11y contracts (issue #595).
 *
 * Pins the inert / :focus-within / focus-ring wiring that keeps auto-hidden
 * Exit/Fullscreen out of the tab order. Behavioral coverage (fake timers,
 * Tab reveal, activate, persistence) lives in player-display-fullscreen.spec.ts.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = resolve(__dirname, '../../src/features/screen/PlayerDisplayPage.tsx');

test.describe('Player Display cast controls a11y (issue #595)', () => {
  const source = readFileSync(PAGE, 'utf8');

  test('marks auto-hidden controls inert and drops inert on keyboard reveal', () => {
    expect(source).toMatch(/setAttribute\('inert'/);
    expect(source).toMatch(/removeAttribute\('inert'/);
    expect(source).toMatch(/keepControlsVisible/);
    // Same-keystroke Tab must clear inert before the browser moves focus.
    expect(source).toMatch(/function handleKeyDown[\s\S]*removeAttribute\('inert'\)[\s\S]*ping\(event\)/);
  });

  test('uses data-visible + :focus-within instead of opacity-only hiding', () => {
    expect(source).toMatch(/data-visible=\{keepControlsVisible/);
    expect(source).toMatch(/\[data-visible="false"\]:not\(:focus-within\)/);
    expect(source).not.toMatch(/style=\{\{\s*opacity:\s*keepControlsVisible/);
  });

  test('keeps fullscreen notices as a visibility force (never inert while shown)', () => {
    expect(source).toMatch(
      /keepControlsVisible\s*=\s*controlsVisible\s*\|\|\s*displayedFullscreenNotice\s*!=\s*null/,
    );
  });

  test('provides a strong cast-control focus ring', () => {
    expect(source).toMatch(/\.cf-screen-controls\s+\.btn:focus-visible/);
    expect(source).toMatch(/outline:\s*3px\s+solid/);
  });
});
