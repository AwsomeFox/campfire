/**
 * AI setup checklist WIRING (issue #519).
 *
 * The readiness rules themselves are asserted in apps/server/test/unit/ai-dm-readiness-rules
 * .spec.ts, which CI actually runs (`*.unit.spec.ts` here never executes — issue #1516).
 * What is left for this file is the component wiring those rules: that the banner and the
 * progress tally both come from the shared rules rather than being re-derived here, that the
 * check body is localized off the server's `detailKey`, and that the catalog carries the mode
 * step's copy.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { localizeDetailParams } from '../../src/features/ai-dm/aiReadiness';

const CHECKLIST = resolve(__dirname, '../../src/features/ai-dm/AiSetupChecklist.tsx');
const EN_CATALOG = resolve(__dirname, '../../src/i18n/locales/en/aiOnboarding.json');

test.describe('AI setup checklist readiness (#519)', () => {
  test('the banner and the tally both come from the shared rules', () => {
    const source = readFileSync(CHECKLIST, 'utf8');
    expect(source).toMatch(/const allDone = aiDmSetupComplete\(readiness\)/);
    expect(source).toMatch(/aiDmReadinessProgress\(readiness\)/);
    // The old formula must not creep back in, and neither may a locally re-derived tally
    // that could disagree with the banner.
    expect(source).not.toMatch(/readiness\.driverOk \|\|/);
    expect(source).not.toMatch(/const gating = steps\.filter/);
  });

  test('check bodies are translated from the server detailKey, with the English detail as fallback', () => {
    const source = readFileSync(CHECKLIST, 'utf8');
    expect(source).toMatch(/aiOnboarding\.checklist\.checkDetails\.\$\{check\.detailKey\}/);
    expect(source).toMatch(/defaultValue: check\.detail/);
    // The raw server string must not be rendered directly any more.
    expect(source).not.toMatch(/body: check\.detail,/);
  });

  test('the catalog carries a title, fix label and detail variants for the mode step', () => {
    const catalog = JSON.parse(readFileSync(EN_CATALOG, 'utf8')) as {
      aiOnboarding: {
        checklist: {
          checkTitles: Record<string, string>;
          fixLabels: Record<string, string>;
          checkDetails: Record<string, Record<string, string>>;
        };
      };
    };
    const { checkTitles, fixLabels, checkDetails } = catalog.aiOnboarding.checklist;
    expect(checkTitles.mode).toBeTruthy();
    expect(fixLabels.mode).toBeTruthy();
    expect(Object.keys(checkDetails.mode).sort()).toEqual(['coDm', 'driver', 'off']);
  });

  test('numeric detail params are grouped for the active locale, strings pass through', () => {
    const out = localizeDetailParams({ total: 1234567, model: 'gpt-4o-mini' });
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.total).toBe((1234567).toLocaleString());
    expect(localizeDetailParams(undefined)).toEqual({});
  });
});
