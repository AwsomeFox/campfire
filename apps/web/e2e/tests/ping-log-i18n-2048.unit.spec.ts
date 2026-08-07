/**
 * Ping log and screen-reader announcements render half-translated (issue #2048).
 *
 * #2046 added translated ping intent labels (`encounters.map.ping.intents.*`) but
 * built the surrounding sentence as a hardcoded English template literal in three
 * places: the visible ping log in `BattleMap.tsx`, and the screen-reader
 * `announce()` calls in `RunSessionPage.tsx` and `PlayerDisplayPage.tsx`. Under a
 * non-English locale the translated intent label landed inside an untranslated
 * English sentence — half English, half the active locale — which hit assistive
 * announcements as well as the visible log. The `senderName` null fallback
 * (`'Someone'`) was a third untranslated literal in the same expression.
 *
 * A test asserting only the *English* output would pass against the bug (the
 * English literal happens to read correctly in English). This is a source-scan
 * test (no rendering, no server) in the style of `ai-admin-settings-i18n.unit.spec.ts`
 * (issue #1579) and `check-i18n-catalog.mjs`'s hardcoded-pattern scan: it pins that
 * all three sites now call `t()` with the same interpolated keys instead of
 * composing a template literal, and that the `ar` catalog carries a genuine,
 * fully-Arabic sentence — i.e. it fails against the pre-#2048 source.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import i18next from 'i18next';
import encountersEn from '../../src/i18n/locales/en/encounters.json';
import encountersAr from '../../src/i18n/locales/ar/encounters.json';

const ROOT = resolve(__dirname, '../../src');
const BATTLE_MAP = resolve(ROOT, 'features/encounters/map/BattleMap.tsx');
const RUN_SESSION_PAGE = resolve(ROOT, 'features/encounters/RunSessionPage.tsx');
const PLAYER_DISPLAY_PAGE = resolve(ROOT, 'features/screen/PlayerDisplayPage.tsx');

const ARABIC = /[؀-ۿ]/;
const LATIN_LETTERS = /[A-Za-z]/;

// The exact hardcoded fragments issue #2048 evidenced. None may survive in any of
// the three sites — reverting any one site back to composing its own template
// literal must fail one of these checks even though the catalog keys stay intact.
const OLD_LABELED_TEMPLATE = /\$\{[\w.]+\.senderName\}\s*pings:\s*\$\{[\w.]+\.label\}/;
const OLD_PLAIN_TEMPLATE_BARE = /:\s*'pinged'/;
const OLD_PLAIN_TEMPLATE_MAP = /pinged the map`/;
const OLD_SENDER_FALLBACK = /\|\|\s*'Someone'/;

function readSrc(path: string): string {
  return readFileSync(path, 'utf8');
}

test.describe('ping log + announcement localization (#2048)', () => {
  test('BattleMap.tsx: visible ping log no longer composes an English template literal', () => {
    const src = readSrc(BATTLE_MAP);
    expect(src, 'must not compose the labeled ping sentence as a template literal').not.toMatch(OLD_LABELED_TEMPLATE);
    expect(src, "must not use the bare 'pinged' literal").not.toMatch(OLD_PLAIN_TEMPLATE_BARE);
    expect(src, "must not hardcode the 'Someone' sender fallback").not.toMatch(OLD_SENDER_FALLBACK);
    expect(src).toContain("t('encounters.map.ping.log.labeled'");
    expect(src).toContain("t('encounters.map.ping.log.plain'");
    expect(src).toContain("t('encounters.map.ping.log.unknownSender')");
  });

  test('RunSessionPage.tsx: addPing announcement derives from the same keys as the visible log', () => {
    const src = readSrc(RUN_SESSION_PAGE);
    expect(src, 'must not compose the labeled ping announcement as a template literal').not.toMatch(OLD_LABELED_TEMPLATE);
    expect(src, "must not hardcode 'pinged the map' as a template literal").not.toMatch(OLD_PLAIN_TEMPLATE_MAP);
    expect(src).toContain("t('encounters.map.ping.log.labeled'");
    expect(src).toContain("t('encounters.map.ping.log.plain'");
  });

  test('PlayerDisplayPage.tsx: addMapPing announcement is translated and derives from the same keys', () => {
    const src = readSrc(PLAYER_DISPLAY_PAGE);
    // Before #2048 this file had no i18n wiring at all for the ping announcement.
    expect(src, 'must import useTranslation').toContain("from 'react-i18next'");
    expect(src, 'must call the hook').toMatch(/useTranslation\(\)/);
    expect(src, 'must not compose the labeled ping announcement as a template literal').not.toMatch(OLD_LABELED_TEMPLATE);
    expect(src, "must not hardcode 'pinged the map' as a template literal").not.toMatch(OLD_PLAIN_TEMPLATE_MAP);
    expect(src).toContain("t('encounters.map.ping.log.labeled'");
    expect(src).toContain("t('encounters.map.ping.log.plain'");
  });

  test('all three sites derive from the exact same key strings — no divergent per-site wording', () => {
    const sources = [readSrc(BATTLE_MAP), readSrc(RUN_SESSION_PAGE), readSrc(PLAYER_DISPLAY_PAGE)];
    for (const src of sources) {
      expect(src).toContain('encounters.map.ping.log.labeled');
      expect(src).toContain('encounters.map.ping.log.plain');
    }
  });

  test('encounters.map.ping.log keys exist with matching interpolated shape in en and ar', () => {
    expect(encountersEn.encounters.map.ping.log.labeled).toBe('{{name}} pings: {{label}}');
    expect(encountersEn.encounters.map.ping.log.plain).toBe('{{name}} pinged the map');
    expect(encountersEn.encounters.map.ping.log.unknownSender).toBe('Someone');
    expect(encountersAr.encounters.map.ping.log.labeled).toContain('{{name}}');
    expect(encountersAr.encounters.map.ping.log.labeled).toContain('{{label}}');
    expect(encountersAr.encounters.map.ping.log.plain).toContain('{{name}}');
    expect(encountersAr.encounters.map.ping.log.unknownSender).toBeTruthy();
  });

  test('the ar values are genuine Arabic, not English placeholders', () => {
    const samples = [
      encountersAr.encounters.map.ping.log.labeled,
      encountersAr.encounters.map.ping.log.plain,
      encountersAr.encounters.map.ping.log.unknownSender,
    ];
    for (const value of samples) {
      expect(value, `expected Arabic script in: ${value}`).toMatch(ARABIC);
    }
    expect(encountersAr.encounters.map.ping.log.unknownSender).not.toBe(encountersEn.encounters.map.ping.log.unknownSender);
  });

  test('rendering the ar catalog produces a fully-Arabic sentence with no leftover English words', async () => {
    // This is the assertion the issue calls the meaningful one: a test that only checks the
    // English-rendered sentence passes against the bug, because the bug IS the English
    // sentence — it just happens to be correct in English. Render through the real `ar`
    // catalog instead and confirm no Latin-script fragment ("pings", "pinged", "Someone")
    // survives in the interpolated output.
    const translator = i18next.createInstance();
    await translator.init({
      resources: {
        en: { translation: encountersEn },
        ar: { translation: encountersAr },
      },
      lng: 'en',
      fallbackLng: 'en',
    });

    const enLabeled = translator.t('encounters.map.ping.log.labeled', { name: 'Zara', label: 'Danger' });
    expect(enLabeled).toBe('Zara pings: Danger');
    const enPlain = translator.t('encounters.map.ping.log.plain', { name: 'Zara' });
    expect(enPlain).toBe('Zara pinged the map');
    const enUnknown = translator.t('encounters.map.ping.log.labeled', {
      name: translator.t('encounters.map.ping.log.unknownSender'),
      label: 'Danger',
    });
    expect(enUnknown).toBe('Someone pings: Danger');

    await translator.changeLanguage('ar');
    // The intent label itself ("Danger") is caller-supplied and already resolved through
    // `encounters.map.ping.intents.*` upstream (issue #1937) — the sentence *around* it is
    // what #2048 is about, so it must be fully Arabic even though the interpolated label
    // in this isolated test is still the Latin word "Danger".
    const arLabeled = translator.t('encounters.map.ping.log.labeled', { name: 'زارا', label: 'خطر' });
    expect(arLabeled).toMatch(ARABIC);
    expect(arLabeled).not.toMatch(/pings/i);
    const arPlain = translator.t('encounters.map.ping.log.plain', { name: 'زارا' });
    expect(arPlain).toMatch(ARABIC);
    expect(arPlain).not.toMatch(/pinged/i);
    const arUnknown = translator.t('encounters.map.ping.log.unknownSender');
    expect(arUnknown).toMatch(ARABIC);
    expect(arUnknown).not.toMatch(/someone/i);
    // Strip the interpolated (still-Latin, caller-supplied) name/label out and confirm the
    // surrounding sentence itself carries no residual Latin letters.
    const arLabeledFrame = arLabeled.replace('زارا', '').replace('خطر', '');
    expect(arLabeledFrame, `expected no residual Latin letters in the sentence frame: ${arLabeledFrame}`).not.toMatch(LATIN_LETTERS);
    const arPlainFrame = arPlain.replace('زارا', '');
    expect(arPlainFrame, `expected no residual Latin letters in the sentence frame: ${arPlainFrame}`).not.toMatch(LATIN_LETTERS);
  });
});
