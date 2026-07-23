/**
 * Preferences accent UX surface (issue #795).
 *
 * Source-level guard: the theme card must expose a real multi-state preview and
 * explicit Apply / Cancel / Reset controls — not just a color dot after save.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = resolve(__dirname, '../../src/features/preferences/PreferencesPage.tsx');
const SOURCE = readFileSync(PAGE, 'utf8');

test.describe('Preferences accent preview UX (#795)', () => {
  test('renders a multi-state accent preview, not only a color dot', () => {
    expect(SOURCE).toContain('data-testid="accent-state-preview"');
    expect(SOURCE).toContain('data-testid="accent-preview-link"');
    expect(SOURCE).toContain('data-testid="accent-preview-button"');
    expect(SOURCE).toContain('data-testid="accent-preview-hover"');
    expect(SOURCE).toContain('data-testid="accent-preview-chip"');
    expect(SOURCE).toContain('data-testid="accent-preview-selected"');
    expect(SOURCE).toContain('data-testid="accent-preview-focus"');
    // The old "dot-only" preview is gone.
    expect(SOURCE).not.toMatch(/aria-hidden\s*\n\s*style=\{\{\s*\n\s*width:\s*28/);
  });

  test('exposes explicit Apply / Cancel / Reset for the accent draft', () => {
    expect(SOURCE).toContain('data-testid="accent-apply"');
    expect(SOURCE).toContain('data-testid="accent-cancel"');
    expect(SOURCE).toContain('data-testid="accent-reset"');
    expect(SOURCE).toContain('buildAccentPalette');
    expect(SOURCE).toContain('applyAccentColor');
    expect(SOURCE).toContain('cancelAccent');
    expect(SOURCE).toContain('resetAccent');
  });
});
