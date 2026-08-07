#!/usr/bin/env node
import assert from 'node:assert';
import {
  extractJsxTextNodes,
  looksUntranslated,
  countUntranslatedInCatalog,
  evaluateTranslationRatchet,
} from './check-i18n-catalog.mjs';

const AR_SCRIPT_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

// Fixture 1: Plain hardcoded JSX text node -> MUST flag
const hardcodedFixture = '<div><button>Save Changes</button></div>';
const hardcodedNodes = extractJsxTextNodes(hardcodedFixture);
assert.strictEqual(hardcodedNodes.length, 1);
assert.strictEqual(hardcodedNodes[0], 'Save Changes');

// Fixture 2: Translated t('key') call -> MUST NOT flag
const translatedFixture = '<div>{t("common.save", "Save Changes")}</div>';
const translatedNodes = extractJsxTextNodes(translatedFixture);
assert.strictEqual(translatedNodes.length, 0);

// Fixture 3: data-testid and className attributes -> MUST NOT flag
const attrFixture = '<div data-testid="save-btn" className="btn-primary"><span>12</span></div>';
const attrNodes = extractJsxTextNodes(attrFixture);
assert.strictEqual(attrNodes.length, 0);

// Fixture 4: Dice notation literal -> MUST NOT flag
const diceFixture = '<div><span>1d8+4</span><span>d20</span></div>';
const diceNodes = extractJsxTextNodes(diceFixture);
assert.strictEqual(diceNodes.length, 0);

// --- looksUntranslated (issue #2059) ---

// English word copied verbatim into the ar slot, no Arabic script -> MUST flag
assert.strictEqual(looksUntranslated('Dashboard', AR_SCRIPT_RE), true);

// Actually translated into Arabic script -> MUST NOT flag
assert.strictEqual(looksUntranslated('لوحة القيادة', AR_SCRIPT_RE), false);

// Keyboard-shortcut-style token, legitimately identical across locales -> MUST NOT flag
assert.strictEqual(looksUntranslated('Shift+Enter', AR_SCRIPT_RE), false);
assert.strictEqual(looksUntranslated('Ctrl+K', AR_SCRIPT_RE), false);

// Placeholder-only value, nothing to translate -> MUST NOT flag
assert.strictEqual(looksUntranslated('{{count}}', AR_SCRIPT_RE), false);

// Symbols/numbers only -> MUST NOT flag
assert.strictEqual(looksUntranslated('100%', AR_SCRIPT_RE), false);
assert.strictEqual(looksUntranslated('→', AR_SCRIPT_RE), false);

// Real English prose around a placeholder, ar identical to en -> MUST flag (the placeholder
// itself does not excuse the surrounding untranslated text)
assert.strictEqual(looksUntranslated('Roll {{count}} dice', AR_SCRIPT_RE), true);

// Non-string values (numbers, arrays) are not translatable text -> MUST NOT flag
assert.strictEqual(looksUntranslated(5, AR_SCRIPT_RE), false);
assert.strictEqual(looksUntranslated(['a', 'b'], AR_SCRIPT_RE), false);

// --- countUntranslatedInCatalog (issue #2059) ---

const enCatalog = {
  nav: { dashboard: 'Dashboard', quests: 'Quests' },
  shortcut: 'Shift+Enter',
  count: '{{count}} items',
};
const partiallyTranslatedArCatalog = {
  nav: { dashboard: 'لوحة القيادة', quests: 'Quests' }, // one translated, one not
  shortcut: 'Shift+Enter', // legitimately identical, not counted
  count: '{{count}} items', // untranslated prose around the placeholder, counted
};
assert.strictEqual(countUntranslatedInCatalog(enCatalog, partiallyTranslatedArCatalog, AR_SCRIPT_RE), 2);

const fullyTranslatedArCatalog = {
  nav: { dashboard: 'لوحة القيادة', quests: 'المهام' },
  shortcut: 'Shift+Enter',
  count: '{{count}} عناصر',
};
assert.strictEqual(countUntranslatedInCatalog(enCatalog, fullyTranslatedArCatalog, AR_SCRIPT_RE), 0);

// A key present only in the target catalog (not in English) is not this check's concern —
// checkKeyParity already reports catalog drift; the ratchet must not double-count it.
const arCatalogWithExtraKey = {
  ...fullyTranslatedArCatalog,
  extraOnlyInAr: 'Untranslated extra',
};
assert.strictEqual(countUntranslatedInCatalog(enCatalog, arCatalogWithExtraKey, AR_SCRIPT_RE), 0);

// --- evaluateTranslationRatchet (issue #2059) ---

// Count strictly above baseline -> MUST fail with a message naming the file
const risenErrors = evaluateTranslationRatchet(
  { 'apps/web/src/i18n/locales/ar/nav.json': 80 },
  { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
);
assert.strictEqual(risenErrors.length, 1);
assert.match(risenErrors[0], /nav\.json/);
assert.match(risenErrors[0], /exceeding baseline of 76/);

// Count equal to baseline -> MUST pass (no regression)
assert.deepStrictEqual(
  evaluateTranslationRatchet(
    { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
    { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
  ),
  [],
);

// Count fallen below baseline (someone translated more) -> MUST pass, not required to lower it
assert.deepStrictEqual(
  evaluateTranslationRatchet(
    { 'apps/web/src/i18n/locales/ar/nav.json': 10 },
    { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
  ),
  [],
);

// A file with no recorded baseline entry defaults to an allowance of 0 (new file starts clean)
assert.strictEqual(
  evaluateTranslationRatchet({ 'apps/web/src/i18n/locales/ar/newFile.json': 1 }, {}).length,
  1,
);

console.log('check-i18n-catalog.spec: ok — all self-test fixtures passed');
