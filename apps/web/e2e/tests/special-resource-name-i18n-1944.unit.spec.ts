/**
 * The DM Award control and player Spend pip for the adapter-declared special resource
 * (5e inspiration / PF2e hero points, issue #1944) interpolated the adapter's raw
 * English `def.name` into otherwise-translated strings, instead of the translated name
 * `adapterResourceLabel` (`lib/adapterVocabularyLabel.ts`, issue #2053) already provides
 * and `CharacterPage`'s `AdapterResourceCard` already uses for the exact same resource.
 *
 * A test asserting only the ENGLISH rendering ("Award Inspiration") PASSES AGAINST THE
 * BUG, because the bug IS the English string — it happens to be correct in English. This
 * follows `adapter-vocabulary-i18n-2053.unit.spec.ts`'s technique instead: a source-scan
 * pinning the old raw-`def.name` shapes are gone and `adapterResourceLabel` is now used at
 * each site, plus a genuine i18next render through the real `ar` catalog asserting the
 * composed sentence carries zero residual Latin-script fragments.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import i18next from 'i18next';
import encountersEn from '../../src/i18n/locales/en/encounters.json';
import encountersAr from '../../src/i18n/locales/ar/encounters.json';
import { adapterResourceLabel } from '../../src/lib/adapterVocabularyLabel';

const ROOT = resolve(__dirname, '../../src');
const PLAYER_VITALS_HEADER = resolve(ROOT, 'features/encounters/PlayerVitalsHeader.tsx');
const COMBATANT_ROW = resolve(ROOT, 'features/encounters/combat/CombatantRow.tsx');

const ARABIC = /[؀-ۿ]/;
const LATIN_LETTERS = /[A-Za-z]/;

// The exact pre-fix shapes the review evidenced. None may survive at their call sites —
// reverting any one site back to interpolating the adapter's raw `.name` must fail one of
// these checks even though the surrounding translated sentence keys stay intact.
const OLD_PIP_LABEL = /\{def\.name\}\s*\{available\}\/\{max\}/;
const OLD_PIP_ARIA = /encounters\.specialResource\.available',\s*\{\s*available,\s*max,\s*name:\s*def\.name/;
const OLD_PIP_SPEND_BUTTON = /encounters\.specialResource\.spend',\s*\{\s*name:\s*def\.name/;
const OLD_PIP_SPEND_CONFIRM = /encounters\.specialResource\.spendConfirm',\s*\{\s*name:\s*def\.name/;
const OLD_PIP_SPENT_TOAST = /encounters\.specialResource\.spentToast',\s*\{\s*name:\s*def\.name/;
const OLD_PIP_RECEIVED_ANNOUNCE = /encounters\.specialResource\.receivedAnnounce',\s*\{\s*name:\s*def\.name/;
const OLD_AWARD_BUTTON = /encounters\.specialResource\.award',\s*\{\s*name:\s*specialResourceDef\.name/;
const OLD_AWARDED_ANNOUNCE = /encounters\.specialResource\.awardedAnnounce',\s*\{\s*name:\s*specialResourceDef\.name/;

function readSrc(path: string): string {
  return readFileSync(path, 'utf8');
}

test.describe('special-resource control name localization (issue #1944 review)', () => {
  test('PlayerVitalsHeader.tsx: SpecialResourcePip no longer interpolates the raw adapter name', () => {
    const src = readSrc(PLAYER_VITALS_HEADER);
    expect(src, 'pip label must not render def.name directly').not.toMatch(OLD_PIP_LABEL);
    expect(src, 'the "available" aria-label must not interpolate def.name directly').not.toMatch(OLD_PIP_ARIA);
    expect(src, 'the Spend button text must not interpolate def.name directly').not.toMatch(OLD_PIP_SPEND_BUTTON);
    expect(src, 'the spend confirm() prompt must not interpolate def.name directly').not.toMatch(OLD_PIP_SPEND_CONFIRM);
    expect(src, 'the spent announcement must not interpolate def.name directly').not.toMatch(OLD_PIP_SPENT_TOAST);
    expect(src, 'the received announcement must not interpolate def.name directly').not.toMatch(OLD_PIP_RECEIVED_ANNOUNCE);
    expect(src).toContain('adapterResourceLabel(t, def)');
  });

  test('CombatantRow.tsx: the Award button and awardedAnnounce no longer interpolate the raw adapter name', () => {
    const src = readSrc(COMBATANT_ROW);
    expect(src, 'the Award button text must not interpolate specialResourceDef.name directly').not.toMatch(OLD_AWARD_BUTTON);
    expect(src, 'the awarded announcement must not interpolate specialResourceDef.name directly').not.toMatch(OLD_AWARDED_ANNOUNCE);
    expect(src).toContain('adapterResourceLabel(t, specialResourceDef)');
  });

  test('rendering the special-resource strings through the real ar catalog produces Arabic, not English', async () => {
    // This is the assertion that actually matters: a test that only checks the
    // English-rendered sentence passes against the bug, because the bug IS the English
    // sentence. Render through the real `ar` catalog instead and confirm no Latin-script
    // fragment survives — not just a translated frame wrapped around an English noun.
    const translator = i18next.createInstance();
    await translator.init({
      resources: { en: { translation: encountersEn }, ar: { translation: encountersAr } },
      lng: 'ar',
      fallbackLng: 'en',
    });
    const t = translator.t.bind(translator);

    const arInspiration = adapterResourceLabel(t, { key: 'inspiration', name: 'Inspiration' });
    expect(arInspiration).toMatch(ARABIC);
    expect(arInspiration).not.toMatch(/inspiration/i);

    const arHeroPoints = adapterResourceLabel(t, { key: 'heroPoints', name: 'Hero Points' });
    expect(arHeroPoints).toMatch(ARABIC);
    expect(arHeroPoints).not.toMatch(/hero/i);

    // Compose the actual sentence keys these call sites use, with the resource name
    // ALREADY translated per the fix — the whole rendered sentence must carry no Latin
    // letters at all, because the previously-untranslated word is translated too.
    const awardSentence = t('encounters.specialResource.award', { name: arInspiration });
    expect(awardSentence, `expected no residual Latin letters: ${awardSentence}`).not.toMatch(LATIN_LETTERS);
    expect(awardSentence).toMatch(ARABIC);

    const awardedAnnounceSentence = t('encounters.specialResource.awardedAnnounce', {
      name: arInspiration,
      combatantName: 'أيلا',
    });
    expect(awardedAnnounceSentence, `expected no residual Latin letters: ${awardedAnnounceSentence}`).not.toMatch(LATIN_LETTERS);

    const spendSentence = t('encounters.specialResource.spend', { name: arHeroPoints });
    expect(spendSentence, `expected no residual Latin letters: ${spendSentence}`).not.toMatch(LATIN_LETTERS);

    const spendConfirmSentence = t('encounters.specialResource.spendConfirm', { name: arHeroPoints });
    expect(spendConfirmSentence, `expected no residual Latin letters: ${spendConfirmSentence}`).not.toMatch(LATIN_LETTERS);

    const spentToastSentence = t('encounters.specialResource.spentToast', { name: arInspiration });
    expect(spentToastSentence, `expected no residual Latin letters: ${spentToastSentence}`).not.toMatch(LATIN_LETTERS);

    const availableSentence = t('encounters.specialResource.available', { available: 1, max: 1, name: arInspiration });
    expect(availableSentence, `expected no residual Latin letters: ${availableSentence}`).not.toMatch(LATIN_LETTERS);

    const receivedAnnounceSentence = t('encounters.specialResource.receivedAnnounce', { name: arHeroPoints });
    expect(receivedAnnounceSentence, `expected no residual Latin letters: ${receivedAnnounceSentence}`).not.toMatch(LATIN_LETTERS);
  });
});
