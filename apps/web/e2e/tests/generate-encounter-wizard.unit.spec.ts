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
const EN_ENCOUNTERS = resolve(__dirname, '../../src/i18n/locales/en/encounters.json');

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
    expect(src).toMatch(/setGenerating/);
    // The button's label is no longer an English literal in the component — it is
    // `t('encounters.generate')`. Asserting the literal here made this test fail the
    // moment the page was internationalised, even though the entry point never went
    // away. Check the wiring in the component and the COPY in the en catalog, which is
    // where the words now live; between them the original claim still holds end to end.
    expect(src).toMatch(/t\(['"]encounters\.generate['"]\)/);
    const en = JSON.parse(readFileSync(EN_ENCOUNTERS, 'utf8')) as { encounters?: Record<string, unknown> };
    expect(en.encounters?.generate).toBe('Generate encounter');
  });

  // Issue #1928: a registered non-5e rule system has no encounter-difficulty math of its own
  // (the existing `unsupported-system` warning already covers that), but the target band still
  // sizes the roster via the internal 5e-shaped count/CR heuristic — that must be labelled
  // 'heuristic', not silently presented as this system's own math.
  test('labels the target band "heuristic" when difficultySupport is heuristic (issue #1928)', () => {
    const src = readFileSync(WIZARD, 'utf8');
    expect(src).toMatch(/preview\.difficultySupport === 'heuristic'/);
    expect(src).toMatch(/t\(['"]encounters\.wizard\.heuristicDifficultyBadge['"]/);
    const en = JSON.parse(readFileSync(EN_ENCOUNTERS, 'utf8')) as { encounters?: { wizard?: Record<string, unknown> } };
    expect(en.encounters?.wizard?.heuristicDifficultyBadge).toBe('Target band: heuristic');
    const ar = JSON.parse(readFileSync(resolve(__dirname, '../../src/i18n/locales/ar/encounters.json'), 'utf8')) as {
      encounters?: { wizard?: Record<string, unknown> };
    };
    // Real Arabic copy, not an English passthrough (the ar catalog otherwise leaves some
    // pre-existing strings untranslated, but new strings must not add to that debt).
    expect(ar.encounters?.wizard?.heuristicDifficultyBadge).not.toBe(en.encounters?.wizard?.heuristicDifficultyBadge);
  });
});
