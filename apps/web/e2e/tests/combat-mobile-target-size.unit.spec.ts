/**
 * Issue #428 — encounter combat / map controls must ship with WCAG 2.2 target
 * sizes (44×44 for primary combat actions). These source assertions catch a
 * regression that reintroduces the old 13×13 death-save pips, 16px attack
 * links, 21px map chips, or 11px dismiss glyphs without needing a browser.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const INDEX_CSS = resolve(ROOT, 'src/index.css');
const RUN_SESSION = resolve(ROOT, 'src/features/encounters/RunSessionPage.tsx');
const STAT_CARD = resolve(ROOT, 'src/components/CharacterStatCard.tsx');
const ROLL_BANNER = resolve(ROOT, 'src/components/RollResultBanner.tsx');

test.describe('combat mobile target-size source contracts (issue #428)', () => {
  test('CSS helpers define 44px primary and 24px minimum targets', () => {
    const css = readFileSync(INDEX_CSS, 'utf8');
    expect(css).toMatch(/\.cf-target-44\s*\{[^}]*min-width:\s*44px/s);
    expect(css).toMatch(/\.cf-target-44\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-target-24\s*\{[^}]*min-(?:width|height):\s*24px/s);
    expect(css).toMatch(/\.cf-death-save-pip\s*\{[^}]*min-width:\s*44px/s);
    expect(css).toMatch(/\.cf-death-save-pip\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-map-tool\s*\{[^}]*min-width:\s*44px/s);
    expect(css).toMatch(/\.cf-map-tool\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-roll-control\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.cf-dismiss-target\s*\{[^}]*min-height:\s*44px/s);
  });

  test('death-save pips, map tools, and apply-bar dismiss use the helpers', () => {
    const source = readFileSync(RUN_SESSION, 'utf8');
    expect(source).toMatch(/className="cf-death-save-pip"/);
    expect(source).not.toMatch(/width:\s*13,\s*\n\s*height:\s*13/);
    expect(source).toMatch(/className="cf-map-tool"/);
    expect(source).toMatch(/className="cf-dismiss-target"/);
    expect(source).toMatch(/data-testid="apply-damage-dismiss"/);
    expect(source).toMatch(/gap:\s*8,\s*flex:\s*'none'/); // HP stepper spacing
  });

  test('attack/damage roll controls are 44px primary targets, not bare link text', () => {
    const source = readFileSync(STAT_CARD, 'utf8');
    expect(source).toMatch(/className="cf-roll-control"/);
    expect(source).toMatch(/data-testid="attack-roll-control"/);
    expect(source).toMatch(/data-testid="damage-roll-control"/);
    // The old inline zero-padding linkish buttons were ~16px tall.
    expect(source).not.toMatch(/className="cf-linkish"[\s\S]{0,200}padding:\s*0/);
  });

  test('roll-result dismiss uses the shared dismiss target', () => {
    const source = readFileSync(ROLL_BANNER, 'utf8');
    expect(source).toMatch(/cf-dismiss-target/);
    expect(source).toMatch(/data-testid="roll-result-dismiss"/);
  });
});
