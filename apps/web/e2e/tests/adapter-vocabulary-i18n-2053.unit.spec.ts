/**
 * Adapter-declared resource and condition names render untranslated (issue #2053).
 *
 * `RuleSystemAdapter.resources[].name` and `.conditions[]` (`@campfire/schema`) are plain
 * English strings — "Inspiration", "Hero Points", "Hit Dice", "Blinded", "Exhaustion", … —
 * baked into the shared domain contract, which stays locale-free by design (it is also
 * consumed by the server, MCP, and the AI surface). Every UI surface that showed one of
 * these names interpolated it raw into an otherwise-translated sentence, so a non-English
 * viewer read a half-translated result — exactly the shape #2048 fixed one layer up, for
 * the words #2048's sentences interpolate.
 *
 * A test asserting only the *English* rendering passes against the bug, because the bug
 * IS the English string. This is a source-scan test (no rendering, no server) in the style
 * of `ping-log-i18n-2048.unit.spec.ts` (issue #2048) plus a genuine i18next render through
 * the real `ar` catalog: it pins that every call site now routes the adapter name through
 * `adapterResourceLabel`/`adapterConditionLabel` (`lib/adapterVocabularyLabel.ts`) instead
 * of the adapter's raw `name`, and that rendering under `ar` produces a sentence with zero
 * residual Latin-script fragments — not just a translated frame around an English word.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import i18next from 'i18next';
import { Dnd5eAdapter, Pf2eAdapter } from '@campfire/schema';
import encountersEn from '../../src/i18n/locales/en/encounters.json';
import encountersAr from '../../src/i18n/locales/ar/encounters.json';
import charactersEn from '../../src/i18n/locales/en/characters.json';
import charactersAr from '../../src/i18n/locales/ar/characters.json';
import { adapterConditionLabel, adapterResourceLabel } from '../../src/lib/adapterVocabularyLabel';

const ROOT = resolve(__dirname, '../../src');
const CHARACTER_PAGE = resolve(ROOT, 'features/characters/CharacterPage.tsx');
const RESOURCE_TRACKER_PANEL = resolve(ROOT, 'features/encounters/ResourceTrackerPanel.tsx');
const BATTLE_MAP = resolve(ROOT, 'features/encounters/map/BattleMap.tsx');

const ARABIC = /[؀-ۿ]/;
const LATIN_LETTERS = /[A-Za-z]/;

// The exact pre-fix shapes the issue evidenced. None may survive at their sites — reverting
// any one site back to interpolating the adapter's raw `.name`/`.condition` must fail one
// of these checks even though the surrounding translated sentence keys stay intact.
const OLD_RESOURCE_HEADING = /card-kicker mb-0">\{def\.name\}<\/h3>/;
const OLD_RESOURCE_AVAILABLE_ARIA = /characters\.resources\.available',\s*\{\s*available,\s*max,\s*name:\s*def\.name\s*\}/;
const OLD_RESOURCE_UPDATE_ERROR = /characters\.resources\.updateError',\s*\{\s*name:\s*def\.name\s*\}/;
const OLD_CONDITION_HEADING = /font-bold uppercase">\{track\.name\}<\/span>/;
const OLD_CONDITION_LEVEL_ARIA = /characters\.conditionLevel\.level',\s*\{\s*level,\s*max:\s*track\.max,\s*name:\s*track\.name\s*\}/;
const OLD_CONDITION_UPDATE_ERROR = /characters\.conditionLevel\.updateError',\s*\{\s*name:\s*track\.name\s*\}/;
const OLD_RESOURCE_TRACKER_RAW = /\{res\.name \|\| key\}/;
const OLD_BATTLEMAP_CONDITIONS = /conditions:\s*badge\.condition\s*\}\)\}\s*title=\{badge\.condition\}/;

function readSrc(path: string): string {
  return readFileSync(path, 'utf8');
}

test.describe('adapter resource/condition name localization (#2053)', () => {
  test('CharacterPage.tsx: AdapterResourceCard no longer interpolates the raw adapter name', () => {
    const src = readSrc(CHARACTER_PAGE);
    expect(src, 'heading must not render def.name directly').not.toMatch(OLD_RESOURCE_HEADING);
    expect(src, 'the "available" aria-label must not interpolate def.name directly').not.toMatch(OLD_RESOURCE_AVAILABLE_ARIA);
    expect(src, 'the update-error message must not interpolate def.name directly').not.toMatch(OLD_RESOURCE_UPDATE_ERROR);
    expect(src).toContain('adapterResourceLabel(t, def)');
  });

  test('CharacterPage.tsx: ConditionLevelRow no longer interpolates the raw track name', () => {
    const src = readSrc(CHARACTER_PAGE);
    expect(src, 'heading must not render track.name directly').not.toMatch(OLD_CONDITION_HEADING);
    expect(src, 'the level aria-label must not interpolate track.name directly').not.toMatch(OLD_CONDITION_LEVEL_ARIA);
    expect(src, 'the update-error message must not interpolate track.name directly').not.toMatch(OLD_CONDITION_UPDATE_ERROR);
    expect(src).toContain('adapterConditionLabel(t, track.name)');
  });

  test('ResourceTrackerPanel.tsx: the per-combatant resource list no longer renders the raw stored name', () => {
    const src = readSrc(RESOURCE_TRACKER_PANEL);
    expect(src, 'must not render res.name || key directly').not.toMatch(OLD_RESOURCE_TRACKER_RAW);
    expect(src).toContain('adapterResourceLabel(t, { key, name: res.name })');
  });

  test('BattleMap.tsx: the token condition badge no longer interpolates the raw condition string', () => {
    const src = readSrc(BATTLE_MAP);
    expect(src, 'aria-label/title must not interpolate badge.condition directly').not.toMatch(OLD_BATTLEMAP_CONDITIONS);
    expect(src).toContain('adapterConditionLabel(t, badge.condition)');
  });

  test('encounters.adapterResource and encounters.adapterCondition catalogs exist in en and ar with matching keys', () => {
    const enResourceKeys = Object.keys(encountersEn.encounters.adapterResource).sort();
    const arResourceKeys = Object.keys(encountersAr.encounters.adapterResource).sort();
    expect(arResourceKeys).toEqual(enResourceKeys);
    expect(enResourceKeys).toEqual(expect.arrayContaining(['inspiration', 'heroPoints', 'hitDice']));

    const enConditionKeys = Object.keys(encountersEn.encounters.adapterCondition).sort();
    const arConditionKeys = Object.keys(encountersAr.encounters.adapterCondition).sort();
    expect(arConditionKeys).toEqual(enConditionKeys);
    expect(enConditionKeys).toEqual(expect.arrayContaining(['Exhaustion', 'Blinded', 'Poisoned']));
  });

  test('the ar adapterResource/adapterCondition values are genuine Arabic, not English placeholders', () => {
    for (const [key, value] of Object.entries(encountersAr.encounters.adapterResource)) {
      expect(value, `expected Arabic script for resource "${key}": ${value}`).toMatch(ARABIC);
      expect(value).not.toBe((encountersEn.encounters.adapterResource as Record<string, string>)[key]);
    }
    for (const [key, value] of Object.entries(encountersAr.encounters.adapterCondition)) {
      expect(value, `expected Arabic script for condition "${key}": ${value}`).toMatch(ARABIC);
      expect(value).not.toBe((encountersEn.encounters.adapterCondition as Record<string, string>)[key]);
    }
  });

  test('a homebrew/unrecognized key falls back to the declared English name, never a raw catalog key or a crash', async () => {
    const translator = i18next.createInstance();
    await translator.init({
      resources: { en: { translation: encountersEn }, ar: { translation: encountersAr } },
      lng: 'ar',
      fallbackLng: 'en',
    });
    const t = translator.t.bind(translator);

    // A homebrew resource/condition has no catalog entry under either locale.
    expect(adapterResourceLabel(t, { key: 'homebrewZorpPool', name: 'Zorp Pool' })).toBe('Zorp Pool');
    expect(adapterConditionLabel(t, 'Zorped')).toBe('Zorped');

    // Never the raw dotted catalog key itself.
    expect(adapterResourceLabel(t, { key: 'homebrewZorpPool', name: 'Zorp Pool' })).not.toContain('encounters.adapterResource');
    expect(adapterConditionLabel(t, 'Zorped')).not.toContain('encounters.adapterCondition');
  });

  test('rendering a known adapter resource/condition through the real ar catalog produces Arabic, not English', async () => {
    // This is the assertion the issue calls the meaningful one: a test that only checks the
    // English-rendered sentence passes against the bug, because the bug IS the English
    // sentence — it just happens to be correct in English. Render through the real `ar`
    // catalog instead and confirm no Latin-script fragment survives.
    const translator = i18next.createInstance();
    await translator.init({
      resources: { en: { translation: encountersEn }, ar: { translation: encountersAr } },
      lng: 'en',
      fallbackLng: 'en',
    });
    const t = translator.t.bind(translator);

    const enInspiration = adapterResourceLabel(t, { key: 'inspiration', name: 'Inspiration' });
    expect(enInspiration).toBe('Inspiration');
    const enExhaustion = adapterConditionLabel(t, 'Exhaustion');
    expect(enExhaustion).toBe('Exhaustion');

    await translator.changeLanguage('ar');
    const arInspiration = adapterResourceLabel(t, { key: 'inspiration', name: 'Inspiration' });
    expect(arInspiration).toMatch(ARABIC);
    expect(arInspiration).not.toMatch(/inspiration/i);
    const arExhaustion = adapterConditionLabel(t, 'Exhaustion');
    expect(arExhaustion).toMatch(ARABIC);
    expect(arExhaustion).not.toMatch(/exhaustion/i);

    // Compose the actual sentence keys these call sites use (characters.json), with the
    // resource/condition name ALREADY translated per the fix — unlike #2048's caller-supplied
    // interpolation (a character name), the whole rendered sentence must now carry no Latin
    // letters at all, because the previously-untranslated word is translated too.
    const charTranslator = i18next.createInstance();
    await charTranslator.init({
      resources: { en: { translation: charactersEn }, ar: { translation: charactersAr } },
      lng: 'ar',
      fallbackLng: 'en',
    });
    const ct = charTranslator.t.bind(charTranslator);

    const availableSentence = ct('characters.resources.available', { available: 1, max: 1, name: arInspiration });
    expect(availableSentence, `expected no residual Latin letters: ${availableSentence}`).not.toMatch(LATIN_LETTERS);
    expect(availableSentence).toMatch(ARABIC);

    const updateErrorSentence = ct('characters.resources.updateError', { name: arInspiration });
    expect(updateErrorSentence, `expected no residual Latin letters: ${updateErrorSentence}`).not.toMatch(LATIN_LETTERS);

    const conditionLevelSentence = ct('characters.conditionLevel.level', { level: 2, max: 6, name: arExhaustion });
    expect(conditionLevelSentence, `expected no residual Latin letters: ${conditionLevelSentence}`).not.toMatch(LATIN_LETTERS);
  });

  test('the screen-reader announcements are translated frames, not English frames around a translated noun', async () => {
    // Translating the noun alone would have RE-CREATED this issue's own defect at these two
    // sites: `announce(\`${label} spent\`)` renders "الإلهام spent" under ar — a translated
    // word inside a hardcoded English sentence, which is precisely the shape #2048 fixed and
    // this issue extends. The frames have to be catalog keys too.
    const src = readSrc(CHARACTER_PAGE);
    expect(src, 'the resource announcement must not build an English frame in a template literal').not.toMatch(
      /announce\(`\$\{resourceLabel\}/,
    );
    expect(src, 'the condition announcement must not build an English frame in a template literal').not.toMatch(
      /announce\(`\$\{conditionLabel\}/,
    );
    expect(src).toContain('characters.resources.announceSpent');
    expect(src).toContain('characters.conditionLevel.announceRaised');

    const charTranslator = i18next.createInstance();
    await charTranslator.init({
      resources: { en: { translation: charactersEn }, ar: { translation: charactersAr } },
      lng: 'ar',
      fallbackLng: 'en',
    });
    const ct = charTranslator.t.bind(charTranslator);
    // The same values the encounters catalog holds for these two, so the fixture reads as the
    // real thing rather than an arbitrary Arabic word; the frame is what is under test here.
    const arInspiration = encountersAr.encounters.adapterResource.inspiration;
    const arExhaustion = encountersAr.encounters.adapterCondition.Exhaustion;

    for (const key of ['characters.resources.announceSpent', 'characters.resources.announceRestored']) {
      const sentence = ct(key, { name: arInspiration });
      expect(sentence, `expected no residual Latin letters for ${key}: ${sentence}`).not.toMatch(LATIN_LETTERS);
      expect(sentence).toMatch(ARABIC);
    }
    for (const key of ['characters.conditionLevel.announceRaised', 'characters.conditionLevel.announceLowered']) {
      const sentence = ct(key, { name: arExhaustion, level: 3 });
      expect(sentence, `expected no residual Latin letters for ${key}: ${sentence}`).not.toMatch(LATIN_LETTERS);
      expect(sentence).toMatch(ARABIC);
    }
  });
});

/**
 * Same-key, different-name resource collision (issue #2068 — a regression #2053
 * introduced). Two shipped adapters declare `key: 'hitDice'` with different display
 * names: 5e's is "Hit Dice", PF2e's is "Hit Dice / Stamina". The single catalog entry
 * `encounters.adapterResource.hitDice` holds 5e's English value, so a plain
 * key-only lookup silently overwrites PF2e's declared name with 5e's — wrong even
 * under `en`, before translation enters into it.
 *
 * The trap: a test that renders under `en` and asserts the string "Hit Dice" PASSES
 * AGAINST THE BUG, because "Hit Dice" is exactly what the bug produces for a 5e
 * resource — and, unfixed, also for the PF2e one. The assertions below instead pin
 * that a PF2e-declared resource renders ITS OWN name, under both `en` and `ar`, and
 * that the fix does not cost 5e's matching case its translation.
 */
test.describe('adapter resource same-key/different-name collision (#2068)', () => {
  const dnd5eHitDice = Dnd5eAdapter.resources?.find((r) => r.key === 'hitDice');
  const pf2eHitDice = Pf2eAdapter.resources?.find((r) => r.key === 'hitDice');

  test('fixture sanity: the real schema still declares the colliding pair this issue is about', () => {
    // If either adapter's declaration changes shape, the rest of this describe block
    // is testing a fixture that no longer matches production — fail loudly here first.
    expect(dnd5eHitDice).toEqual({ key: 'hitDice', name: 'Hit Dice', recharge: 'long-rest' });
    expect(pf2eHitDice?.key).toBe('hitDice');
    expect(pf2eHitDice?.name).toBe('Hit Dice / Stamina');
    expect(pf2eHitDice?.name).not.toBe(dnd5eHitDice?.name);
  });

  async function makeTranslator(lng: 'en' | 'ar') {
    const translator = i18next.createInstance();
    await translator.init({
      resources: { en: { translation: encountersEn }, ar: { translation: encountersAr } },
      lng,
      fallbackLng: 'en',
    });
    return translator.t.bind(translator);
  }

  test('a PF2e-declared resource under a colliding key renders its OWN name under en, never 5e\'s', async () => {
    const t = await makeTranslator('en');
    const label = adapterResourceLabel(t, pf2eHitDice!);
    expect(label).toBe('Hit Dice / Stamina');
    expect(label).not.toBe('Hit Dice');
  });

  test('a PF2e-declared resource under a colliding key renders its OWN name under ar, never 5e\'s translated value', async () => {
    const t = await makeTranslator('ar');
    const label = adapterResourceLabel(t, pf2eHitDice!);
    // Honest degradation: PF2e's name has no catalog entry of its own (the one entry
    // under this key belongs to 5e's English value), so it renders correctly but
    // untranslated rather than translated-but-wrong (5e's Arabic "hitDice" value).
    expect(label).toBe('Hit Dice / Stamina');
    expect(label).not.toBe(encountersAr.encounters.adapterResource.hitDice);
  });

  test('a 5e-declared resource under the SAME key still translates under ar (the fix does not disable the matching case)', async () => {
    const t = await makeTranslator('ar');
    const label = adapterResourceLabel(t, dnd5eHitDice!);
    expect(label).toBe(encountersAr.encounters.adapterResource.hitDice);
    expect(label).toMatch(ARABIC);
  });

  test('a homebrew key with no catalog entry at all still falls back to its own declared name', async () => {
    const t = await makeTranslator('ar');
    const label = adapterResourceLabel(t, { key: 'homebrewSoulEmber', name: 'Soul Ember' });
    expect(label).toBe('Soul Ember');
  });

  test('a stored resource record with a DM/AI-customized name whose key collides keeps the customized name', async () => {
    // A stored `CharacterResource` under key `hitDice` but with a caller-supplied name
    // that is neither adapter's — the customized-name case the issue calls out as
    // fixed "for free" by the English-match rule, since it also fails the match.
    const t = await makeTranslator('en');
    const customized = { key: 'hitDice', name: 'Vigor Dice (homebrew variant)' };
    expect(adapterResourceLabel(t, customized)).toBe('Vigor Dice (homebrew variant)');

    const tAr = await makeTranslator('ar');
    expect(adapterResourceLabel(tAr, customized)).toBe('Vigor Dice (homebrew variant)');
  });

  test('a stored resource record with no display name (or name equal to key) falls back to the catalog entry', async () => {
    // Issue #2068 review finding: when a resource pool is saved without a custom display name,
    // `res.name` is either undefined or defaulted to its key (e.g. 'actionSurge').
    // The name-match rule must not prevent those records from translating.
    const tEn = await makeTranslator('en');
    expect(adapterResourceLabel(tEn, { key: 'actionSurge', name: 'actionSurge' })).toBe('Action Surge');
    expect(adapterResourceLabel(tEn, { key: 'actionSurge' })).toBe('Action Surge');

    const tAr = await makeTranslator('ar');
    expect(adapterResourceLabel(tAr, { key: 'actionSurge', name: 'actionSurge' })).toBe(encountersAr.encounters.adapterResource.actionSurge);
    expect(adapterResourceLabel(tAr, { key: 'actionSurge', name: 'actionSurge' })).toMatch(ARABIC);
    expect(adapterResourceLabel(tAr, { key: 'actionSurge' })).toBe(encountersAr.encounters.adapterResource.actionSurge);
  });
});

