import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isCampaignEvent } from '../../src/lib/useCampaignEvents';

const ROOT = resolve(__dirname, '../..');

test.describe('Shared dice log SSE and spectator roll animations (issue #1899)', () => {
  const schemaSource = readFileSync(resolve(ROOT, '../../packages/schema/src/index.ts'), 'utf8');
  const _eventsSource = readFileSync(resolve(ROOT, 'src/lib/useCampaignEvents.ts'), 'utf8');
  const logSource = readFileSync(resolve(ROOT, 'src/features/dice/SharedDiceLog.tsx'), 'utf8');
  const contextSource = readFileSync(resolve(ROOT, 'src/components/RollResultToastContext.tsx'), 'utf8');
  const toastSource = readFileSync(resolve(ROOT, 'src/components/RollResultToast.tsx'), 'utf8');
  const prefsSource = readFileSync(resolve(ROOT, 'src/features/preferences/PreferencesPage.tsx'), 'utf8');
  const enDiceSource = readFileSync(resolve(ROOT, 'src/i18n/locales/en/dice.json'), 'utf8');
  const arDiceSource = readFileSync(resolve(ROOT, 'src/i18n/locales/ar/dice.json'), 'utf8');
  const enPrefsSource = readFileSync(resolve(ROOT, 'src/i18n/locales/en/preferences.json'), 'utf8');
  const arPrefsSource = readFileSync(resolve(ROOT, 'src/i18n/locales/ar/preferences.json'), 'utf8');

  test('isCampaignEvent accepts thin dice.rolled frames and rejects malformed ones', () => {
    expect(isCampaignEvent({
      type: 'dice.rolled',
      campaignId: 5,
      rollId: 101,
      encounterId: 12,
      at: '2026-08-05T00:00:00.000Z',
    })).toBe(true);
    expect(isCampaignEvent({
      type: 'dice.rolled',
      campaignId: 5,
      rollId: 102,
      at: '2026-08-05T00:00:00.000Z',
    })).toBe(true);
    expect(isCampaignEvent({
      type: 'dice.rolled',
      campaignId: 5,
      rollId: 'invalid-id',
      at: '2026-08-05T00:00:00.000Z',
    })).toBe(false);
    expect(isCampaignEvent({
      type: 'dice.rolled',
      campaignId: 5,
      at: '2026-08-05T00:00:00.000Z',
    })).toBe(false);
  });

  test('schema defines thin dice.rolled CampaignEvent and animateOthersRolls preference', () => {
    expect(schemaSource).toMatch(/type:\s*z\.literal\('dice\.rolled'\)/);
    expect(schemaSource).toMatch(/campaignId:\s*Id/);
    expect(schemaSource).toMatch(/rollId:\s*Id/);
    expect(schemaSource).toMatch(/animateOthersRolls:\s*z\.boolean\(\)\.default\(true\)/);
  });

  test('SharedDiceLog subscribes via useCampaignEvents and demotes 5s polling when connected', () => {
    expect(logSource).toMatch(/useCampaignEvents\(Number\.isFinite\(campaignId\)/);
    expect(logSource).toMatch(/if \(event\.type === 'dice\.rolled'\)\s*\{\s*void load\(\);/);
    expect(logSource).toMatch(/if \(sseStatus === 'connected'\) return;/);
    expect(logSource).toMatch(/DEGRADED_POLL_MS = 60000/);
  });

  test('SharedDiceLog filters fresh non-own rolls, suppresses mount backlog and bursts >2', () => {
    expect(logSource).toMatch(/knownRollIdsRef/);
    expect(logSource).toMatch(/isInitialLoadRef/);
    expect(logSource).toMatch(/now - rollTime >= 8000/);
    expect(logSource).toMatch(/freshNonOwn\.length > 0 && freshNonOwn\.length <= 2/);
    expect(logSource).toMatch(/showRoll\(r, \{ applyDisabled: true \}\)/);
  });

  test('RollResultToastContext prevents apply-damage bridge for non-own rolls', () => {
    expect(contextSource).toMatch(/isOwnRoll = roll != null && me\?\.user\?\.id != null && String\(roll\.rollerUserId\) === String\(me\.user\.id\)/);
    expect(contextSource).toMatch(/!rollApplyDisabled &&\s*isOwnRoll &&\s*roll != null/);
  });

  test('RollResultToast renders spectator attribution <Roller> rolls <expr>', () => {
    expect(toastSource).toMatch(/isNonOwn = me\?\.user\?\.id != null && String\(roll\.rollerUserId\) !== String\(me\.user\.id\)/);
    expect(toastSource).toMatch(/t\('dice\.spectatorAttribution'/);
    expect(enDiceSource).toMatch(/"spectatorAttribution": "{{roller}} rolls {{expr}}"/);
    expect(arDiceSource).toMatch(/"spectatorAttribution": "{{roller}} يرمي {{expr}}"/);
  });

  test('PreferencesPage renders animateOthersRolls toggle and supports i18n', () => {
    expect(prefsSource).toMatch(/animateOthersRolls/);
    expect(prefsSource).toMatch(/toggleAnimateOthersRolls/);
    expect(enPrefsSource).toMatch(/"animateOthersRolls": "Animate others' rolls"/);
    expect(arPrefsSource).toMatch(/"animateOthersRolls": "تحريك رميات الآخرين"/);
  });
});
