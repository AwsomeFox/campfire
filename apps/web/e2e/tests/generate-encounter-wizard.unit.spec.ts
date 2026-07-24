/**
 * Generate-encounter wizard (issue #412).
 *
 * Follows this repo's Playwright "unit" convention (source-assertion, no browser / no seeded
 * backend — see encounter-reopen-confirm-copy.unit.spec.ts): the interactive behaviour is
 * regression-covered end-to-end by the server real-DB e2e (encounters.e2e-spec.ts,
 * describe('encounter preview / tune / idempotent commit (issue #412)')) and the pure logic
 * unit suite (encounter-preview-tune.spec.ts). Here we assert the wizard surface wires every
 * acceptance affordance: preview, difficulty EXPLANATION, per-creature inspection, the tune
 * controls (reroll all / reroll one / adjust count / pin), warnings, actionable fallbacks, and
 * an idempotent commit reachable from the encounter list.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WIZARD = resolve(__dirname, '../../src/features/encounters/GenerateEncounterWizard.tsx');
const LIST = resolve(__dirname, '../../src/features/encounters/EncounterListPage.tsx');

test.describe('Generate-encounter wizard surface (issue #412)', () => {
  test('the wizard exposes preview, explanation, inspection, tune, warnings, and commit', () => {
    const src = readFileSync(WIZARD, 'utf8');
    // Preview + commit endpoints.
    expect(src).toMatch(/encounters\/preview/);
    expect(src).toMatch(/encounters\/commit/);
    // Difficulty explanation (not just a band).
    expect(src).toMatch(/DifficultyExplanationPanel/);
    expect(src).toMatch(/preview\.explanation/);
    expect(src).toMatch(/\.headline/);
    // Per-creature inline inspection: AC/HP/actions/saves/traits.
    expect(src).toMatch(/armorClass/);
    expect(src).toMatch(/hitPointsMax/);
    expect(src).toMatch(/savingThrows/);
    expect(src).toMatch(/insp\.traits/);
    expect(src).toMatch(/insp\.actions/);
    // Tune operations.
    expect(src).toMatch(/reroll-all/);
    expect(src).toMatch(/reroll-slot/);
    expect(src).toMatch(/adjust-count/);
    expect(src).toMatch(/op: 'pin'/);
    expect(src).toMatch(/add-slot/);
    expect(src).toMatch(/remove-slot/);
    // Warnings + fallbacks.
    expect(src).toMatch(/WarningsPanel/);
    expect(src).toMatch(/preview\.fallbacks/);
    // Idempotent commit + hidden/preparing default via audience.
    expect(src).toMatch(/idempotencyKey/);
    expect(src).toMatch(/AudienceField/);
    // Link quest/session/location on commit.
    expect(src).toMatch(/locationId/);
    expect(src).toMatch(/questId/);
    expect(src).toMatch(/sessionId/);
  });

  test('the encounter list offers a "Generate encounter" entry point for the DM', () => {
    const src = readFileSync(LIST, 'utf8');
    expect(src).toMatch(/GenerateEncounterWizard/);
    expect(src).toMatch(/Generate encounter/);
    expect(src).toMatch(/setGenerating/);
  });
});
