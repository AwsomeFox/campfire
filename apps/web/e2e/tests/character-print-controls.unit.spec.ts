import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Issue #1761 — Character print view hides owner-only interactive controls.
 *
 * Ensures print utility classes (cf-print-hide, cf-print-only, cf-print-editor)
 * are correctly attached to owner mutation affordances across character sheet components
 * so paper/PDF output is clean without interactive noise.
 */
test.describe('Character print view owner control hiding (#1761)', () => {
  const characterPagePath = resolve(__dirname, '../../src/features/characters/CharacterPage.tsx');
  const characterInventoryPath = resolve(__dirname, '../../src/features/characters/CharacterInventorySection.tsx');
  const inventorySharedPath = resolve(__dirname, '../../src/features/inventory/inventoryShared.tsx');
  const completionBannerPath = resolve(__dirname, '../../src/features/characters/CharacterCompletionBanner.tsx');

  test('CharacterPage attaches cf-print-hide to interactive owner controls', () => {
    const code = readFileSync(characterPagePath, 'utf8');

    // HP editor & rest controls container
    expect(code).toContain('space-y-2 cf-print-hide');
    expect(code).toMatch(/className="flex gap-2 flex-wrap cf-print-hide"/);
    expect(code).toMatch(/className="flex gap-2 items-center flex-wrap pt-1 cf-print-hide"/);

    // Roll mode choosers and status indicators
    expect(code).toContain('cf-roll-mode-status cf-print-hide');
    expect(code).toContain('<div className="cf-print-hide">\n        <RollModeChooser');

    // Save & skill proficiency toggle buttons
    expect(code).toContain('className="cf-target-44 absolute top-0.5 right-0.5 cf-print-hide"');
    expect(code).toContain('className="cf-target-44 shrink-0 text-center cf-print-hide"');

    // Actions card + Add and action edit/delete controls
    expect(code).toContain('className="text-xs ml-auto cf-print-hide"');
    expect(code).toContain('className="flex items-center gap-1 shrink-0 cf-print-hide"');

    // Spell slots Edit slots and Use/Restore buttons
    expect(code).toContain('className="text-xs ml-auto cf-print-hide"');
    expect(code).toContain('className="inline-flex gap-1 ml-auto cf-print-hide"');

    // XP award & level-up controls
    expect(code).toContain('className="flex gap-2 flex-wrap items-end cf-print-hide"');

    // Portrait upload & story edit
    expect(code).toContain('<div className="cf-print-hide">\n                    <ImageUpload');
    expect(code).toContain('className="text-[length:var(--type-label)] text-secondary cf-print-hide"');
    expect(code).toContain('className="space-y-2 cf-print-editor"');
  });

  test('CharacterInventorySection and inventoryShared hide item mutation controls in print', () => {
    const invCode = readFileSync(characterInventoryPath, 'utf8');
    const sharedCode = readFileSync(inventorySharedPath, 'utf8');

    expect(invCode).toContain('className="text-xs cf-print-hide"');
    expect(sharedCode).toContain('className="shrink-0 mt-0.5 text-[var(--color-accent)] hover:text-[var(--color-accent-700)] cf-print-hide"');
    expect(sharedCode).toContain('className="flex flex-wrap items-center gap-1.5 shrink-0 w-full sm:w-auto sm:ml-auto justify-end cf-print-hide"');
  });

  test('CharacterCompletionBanner hides draft banner in print', () => {
    const code = readFileSync(completionBannerPath, 'utf8');
    expect(code).toContain('Card className="space-y-3 border-amber-700/40 bg-amber-950/20 cf-print-hide"');
  });
});
