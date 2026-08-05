/**
 * Issue #1928 — resolve honesty notice on the Use-flow preview step.
 *
 * Follows this repo's Playwright "unit" convention (source-assertion, no browser / no seeded
 * backend — see generate-encounter-wizard.unit.spec.ts / encounter-reopen-confirm-copy.unit.spec.ts):
 * the interactive behaviour (resolve → preview → commit) is regression-covered end-to-end by
 * the server real-DB e2e (action-resolver.e2e-spec.ts). Here we assert the preview step renders
 * a non-blocking notice ONLY when the server reports `systemMathSupported === false`, using a
 * translated string (not a hardcoded English literal) present in both locale catalogs.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ACTION_USE_FLOW_FILE = resolve(__dirname, '../../src/features/encounters/ActionUseFlow.tsx');
const EN_ENCOUNTERS = resolve(__dirname, '../../src/i18n/locales/en/encounters.json');
const AR_ENCOUNTERS = resolve(__dirname, '../../src/i18n/locales/ar/encounters.json');

test.describe('ActionUseFlow system-math honesty notice (issue #1928)', () => {
  test('renders the notice only when systemMathSupported is false, via a translated string', () => {
    const code = readFileSync(ACTION_USE_FLOW_FILE, 'utf8');

    // Gated strictly on the flag being false — never renders for true/undefined (legacy payload).
    expect(code).toMatch(/preview\.systemMathSupported === false/);
    expect(code).toMatch(/data-testid="action-use-system-math-notice"/);
    expect(code).toMatch(/t\(['"]encounters\.actionFlow\.systemMathNotice['"]/);

    const en = JSON.parse(readFileSync(EN_ENCOUNTERS, 'utf8')) as { encounters?: { actionFlow?: Record<string, unknown> } };
    expect(en.encounters?.actionFlow?.systemMathNotice).toBe('Resolved with 5e-style d20 math — verify against your system.');

    const ar = JSON.parse(readFileSync(AR_ENCOUNTERS, 'utf8')) as { encounters?: { actionFlow?: Record<string, unknown> } };
    // Real Arabic copy, not an English passthrough.
    expect(ar.encounters?.actionFlow?.systemMathNotice).not.toBe(en.encounters?.actionFlow?.systemMathNotice);
    expect(typeof ar.encounters?.actionFlow?.systemMathNotice).toBe('string');
    expect((ar.encounters?.actionFlow?.systemMathNotice as string).length).toBeGreaterThan(0);
  });
});
