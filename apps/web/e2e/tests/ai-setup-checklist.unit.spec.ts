/**
 * AI setup checklist readiness rules (issue #519).
 *
 * Regression under test: the checklist used to declare the AI ready with
 * `allDone = readiness.driverOk || (readiness.ok && mode === 'co_dm')`. No server readiness
 * check reflected the seat's mode, so a table with the provider, model and budget all green
 * but the AI switched OFF got a green "The AI DM is ready" banner whose copy said the AI was
 * co-DMing — while the AI did nothing and the next turn would 403. The mode is now part of
 * the answer on both sides: the server emits a gating `mode` check (and folds the mode into
 * `driverOk`), and the banner asks {@link isAiDmSetupComplete}, which never says yes for an
 * off seat.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAiDmSetupComplete, localizeDetailParams } from '../../src/features/ai-dm/aiReadiness';

const CHECKLIST = resolve(__dirname, '../../src/features/ai-dm/AiSetupChecklist.tsx');
const EN_CATALOG = resolve(__dirname, '../../src/i18n/locales/en/aiOnboarding.json');

test.describe('AI setup checklist readiness (#519)', () => {
  test('an off seat is never "ready", however green the prerequisites are', () => {
    // The exact shape the bug produced: everything configured, mode still off.
    expect(isAiDmSetupComplete({ ok: true, driverOk: true, mode: 'off' })).toBe(false);
    expect(isAiDmSetupComplete({ ok: false, driverOk: false, mode: 'off' })).toBe(false);
  });

  test('each mode owns its own readiness', () => {
    // Driver: the driver aggregate decides — and it now includes "the seat is in driver mode".
    expect(isAiDmSetupComplete({ ok: true, driverOk: true, mode: 'driver' })).toBe(true);
    expect(isAiDmSetupComplete({ ok: true, driverOk: false, mode: 'driver' })).toBe(false);
    // Co-DM: propose-only, so the blocking-check aggregate decides. Driver extras are moot.
    expect(isAiDmSetupComplete({ ok: true, driverOk: false, mode: 'co_dm' })).toBe(true);
    expect(isAiDmSetupComplete({ ok: false, driverOk: true, mode: 'co_dm' })).toBe(false);
  });

  test('the done banner is gated on that rule, not on driverOk alone', () => {
    const source = readFileSync(CHECKLIST, 'utf8');
    expect(source).toMatch(/const allDone = isAiDmSetupComplete\(readiness\)/);
    // The old formula must not creep back in.
    expect(source).not.toMatch(/readiness\.driverOk \|\|/);
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
