/**
 * Semantic text-token contrast (issue #593).
 *
 * Pins the secondary / timestamp / disabled / decorative roles against every
 * opaque and translucent shell background where that role is actually painted.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ROLE_CONTRAST_BACKGROUNDS,
  SEMANTIC_TEXT_TOKEN_VALUES,
  SEMANTIC_TEXT_TOKENS,
  TEXT_LARGE_UI_CONTRAST,
  TEXT_NORMAL_CONTRAST,
  allContrastBackgrounds,
  verifySemanticTextContrast,
  type SemanticTextToken,
} from '../../src/app/textContrastTokens';

const WEB_ROOT = resolve(__dirname, '../..');
const INDEX_CSS = resolve(WEB_ROOT, 'src/index.css');
const NOCTURNE_CSS = resolve(WEB_ROOT, 'src/nocturne.css');

function cssTokenValue(css: string, token: SemanticTextToken): string | null {
  const match = css.match(new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  return match?.[1]?.toLowerCase() ?? null;
}

test.describe('semantic text contrast tokens (#593)', () => {
  test('canonical values meet role-specific contrast floors on audited backgrounds', () => {
    const failures = verifySemanticTextContrast();
    expect(
      failures,
      failures.map((f) => `${f.token} on ${f.background}: ${f.ratio.toFixed(2)} < ${f.floor}`).join('\n'),
    ).toEqual([]);
  });

  test('index.css and nocturne.css define the same semantic token hex values', () => {
    const index = readFileSync(INDEX_CSS, 'utf8');
    const nocturne = readFileSync(NOCTURNE_CSS, 'utf8');
    for (const token of Object.keys(SEMANTIC_TEXT_TOKEN_VALUES) as SemanticTextToken[]) {
      expect(cssTokenValue(index, token), `${token} in index.css`).toBe(SEMANTIC_TEXT_TOKEN_VALUES[token]);
      expect(cssTokenValue(nocturne, token), `${token} in nocturne.css`).toBe(SEMANTIC_TEXT_TOKEN_VALUES[token]);
    }
  });

  test('text-muted aliases secondary instead of translucent color-mix', () => {
    const nocturne = readFileSync(NOCTURNE_CSS, 'utf8');
    expect(nocturne).toContain('.text-muted { color: var(--color-text-secondary); }');
    expect(nocturne).not.toMatch(/\.text-muted\s*\{[^}]*color-mix/);
  });

  test('utility classes map to semantic tokens in index.css', () => {
    const index = readFileSync(INDEX_CSS, 'utf8');
    expect(index).toContain('.text-secondary { color: var(--color-text-secondary); }');
    expect(index).toContain('.text-timestamp { color: var(--color-text-timestamp); }');
    expect(index).toContain('.text-disabled { color: var(--color-text-disabled); }');
    expect(index).toContain('.text-decorative { color: var(--color-text-decorative); }');
  });

  test('every semantic role audits at least app and surface backgrounds', () => {
    for (const role of Object.values(SEMANTIC_TEXT_TOKENS)) {
      expect(ROLE_CONTRAST_BACKGROUNDS[role.role]).toContain('app');
      expect(ROLE_CONTRAST_BACKGROUNDS[role.role]).toContain('surface');
    }
  });

  test('mixed-background fixtures stay discoverable', () => {
    const ids = allContrastBackgrounds().map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(['dm-panel', 'reading-checked', 'tabbar']));
  });

  test('documented contrast floors match WCAG AA expectations', () => {
    expect(TEXT_NORMAL_CONTRAST).toBe(4.5);
    expect(TEXT_LARGE_UI_CONTRAST).toBe(3);
  });
});
