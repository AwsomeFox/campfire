/**
 * Reduced-motion policy contracts (issue #594).
 *
 * Source-level pins so the global CSS + JS gates cannot quietly regress to the
 * old named-class-only block. Computed-style coverage lives in
 * reduced-motion.spec.ts (Playwright media emulation against the live SPA).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prefersReducedMotion, scrollBehavior } from '../../src/lib/prefersReducedMotion';

const ROOT = resolve(__dirname, '../../src');
const INDEX_CSS = resolve(ROOT, 'index.css');
const AI_CHIP = resolve(ROOT, 'features/ai-dm/AiDmActivityChip.tsx');
const AUTHED = resolve(ROOT, 'app/AuthedLayout.tsx');
const UI = resolve(ROOT, 'components/ui.tsx');
const NOTES = resolve(ROOT, 'features/notes/MyNotesPage.tsx');
const SETTINGS = resolve(ROOT, 'features/settings/CampaignSettingsPage.tsx');

test.describe('prefersReducedMotion helper (issue #594)', () => {
  test('maps reduce → auto scroll and no-reduce → smooth', () => {
    const prev = (globalThis as { window?: Window }).window;
    const states = [true, false] as const;
    for (const reduce of states) {
      (globalThis as { window: Window }).window = {
        matchMedia: (query: string) => ({
          matches: reduce && query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener() {},
          removeEventListener() {},
          addListener() {},
          removeListener() {},
          dispatchEvent() { return false; },
          onchange: null,
        }),
      } as unknown as Window;
      expect(prefersReducedMotion()).toBe(reduce);
      expect(scrollBehavior()).toBe(reduce ? 'auto' : 'smooth');
    }
    if (prev) (globalThis as { window: Window }).window = prev;
    else delete (globalThis as { window?: Window }).window;
  });
});

test.describe('global reduced-motion CSS policy (issue #594)', () => {
  const css = readFileSync(INDEX_CSS, 'utf8');
  const reduceBlock = css.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{[\s\S]*$/)?.[0] ?? '';

  test('universal selector zeros animations, transitions, and scroll-behavior', () => {
    expect(reduceBlock, 'prefers-reduced-motion block must exist').toMatch(/prefers-reduced-motion\s*:\s*reduce/);
    expect(reduceBlock).toMatch(/\*\s*,\s*\*::before\s*,\s*\*::after/);
    expect(reduceBlock).toMatch(/animation:\s*none\s*!important/);
    expect(reduceBlock).toMatch(/transition:\s*none\s*!important/);
    expect(reduceBlock).toMatch(/scroll-behavior:\s*auto\s*!important/);
    expect(reduceBlock).toMatch(/html\s*\{\s*scroll-behavior:\s*auto/);
  });

  test('still lists issue #67 decorative classes so named cues stay documented', () => {
    for (const cls of [
      'cf-anim-roll',
      'cf-anim-crit',
      'cf-anim-fumble',
      'cf-anim-hp-damage',
      'cf-hp-flash-damage',
      'cf-hp-flash-heal',
      'cf-anim-ready',
      'cf-anim-levelup',
      'cf-sparkle',
    ]) {
      expect(reduceBlock, `${cls} must remain disabled under reduce`).toContain(cls);
    }
  });
});

test.describe('component gates keep non-motion feedback (issue #594)', () => {
  test('AI presence pulse is gated and text status remains', () => {
    const src = readFileSync(AI_CHIP, 'utf8');
    expect(src).toMatch(/prefersReducedMotion/);
    expect(src).toMatch(/turnActive && !prefersReducedMotion\(\)/);
    expect(src).toContain("AI DM is acting…");
    expect(src).toContain('AI DM is at the table');
    expect(src).toContain('data-ai-dm-active');
  });

  test('auth splash and skeleton expose status text when pulse is frozen', () => {
    const splash = readFileSync(AUTHED, 'utf8');
    expect(splash).toMatch(/role="status"/);
    expect(splash).toMatch(/Loading…/);
    expect(splash).toMatch(/data-testid="auth-splash"/);

    const ui = readFileSync(UI, 'utf8');
    expect(ui).toMatch(/data-testid="skeleton"/);
    expect(ui).toMatch(/role="status"/);
    expect(ui).toMatch(/Loading…/);
    expect(ui).toMatch(/animate-pulse/);
  });

  test('smooth auto-scroll call sites use scrollBehavior()', () => {
    expect(readFileSync(NOTES, 'utf8')).toMatch(/scrollBehavior\(\)/);
    expect(readFileSync(SETTINGS, 'utf8')).toMatch(/scrollBehavior\(\)/);
    expect(readFileSync(SETTINGS, 'utf8')).not.toMatch(/prefers-reduced-motion: reduce'\)\.matches/);
  });
});
