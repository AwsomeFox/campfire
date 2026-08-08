#!/usr/bin/env node
import assert from 'node:assert';
import {
  extractJsxTextNodes,
  looksUntranslated,
  countUntranslatedInCatalog,
  evaluateTranslationRatchet,
  validateBaselineShape,
  findEmptyValues,
  extractUseTranslationNamespaceArgs,
  NON_LATIN_SCRIPT_DETECTORS,
} from './check-i18n-catalog.mjs';

// Use the real detector rather than a copy, so a change to it cannot silently pass these fixtures.
const AR_SCRIPT_RE = NON_LATIN_SCRIPT_DETECTORS.ar;

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

// --- extractJsxTextNodes: concise arrow + generic call (issue #2106) ---
//
// The regex has no real JSX awareness: it matches any `>...<` on one line, anywhere in the
// file. A concise arrow whose body (or return-type annotation) is immediately followed by a
// generic type argument bookends this exact shape — the `>` closing `=>` and the `<` opening
// the generic — with a bare identifier/member-access chain in between that then passes the
// node's own letter-count filter.

// The exact reported shape, `=> fn<T>(` -> MUST NOT flag
assert.deepStrictEqual(extractJsxTextNodes('foo: (x) => api.post<Foo>(url, x),'), []);

// A genuine JSX text node elsewhere in the same source -> MUST still flag, proving the fix does
// not suppress real hardcoded text, only the arrow+generic shape.
assert.deepStrictEqual(
  extractJsxTextNodes('foo: (x) => api.post<Foo>(url, x),\n<button>Save Changes</button>'),
  ['Save Changes'],
);

// The exact #2105/#2106 regression case: `api.post<EncounterWithCombatants>` inside a concise
// arrow mutationFn -> MUST NOT flag ("api.post" must not appear as a hardcoded JSX text node).
const encounterMutationFnFixture =
  '}) => api.patch<EncounterWithCombatants>(`${API}/encounters/${encounterId}`, { ...patch, expectedUpdatedAt }),';
assert.deepStrictEqual(extractJsxTextNodes(encounterMutationFnFixture), []);

// A bare (non-dotted) identifier immediately after `=>` and before a generic `<` -> MUST NOT
// flag, covering the issue title's general `=> fn<T>(` shape, not just dotted member calls.
assert.deepStrictEqual(extractJsxTextNodes('onSave: (patch) => save<Payload>(patch),'), []);

// A `=>` return-type annotation using a generic, e.g. `(): => Promise<void>` -> MUST NOT flag.
assert.deepStrictEqual(
  extractJsxTextNodes('onSave: (patch: Record<string, number | null>) => Promise<void>;'),
  [],
);

// A real JSX text node that merely CONTAINS an identifier-like word is unaffected: nothing here
// is preceded by a literal `=`, so the exclusion must not fire on ordinary JSX.
assert.deepStrictEqual(extractJsxTextNodes('<div>api.post</div>'), ['api.post']);

// A `<` used as a real less-than comparison right after `=>`, with a two-letter-or-more bare
// identifier on the left, is not real JSX text either and is correctly excluded by the same
// narrow rule (it is still not a hardcoded UI string worth flagging).
assert.deepStrictEqual(extractJsxTextNodes('(row) => row < limit'), []);

// --- looksUntranslated (issue #2059) ---

// English word copied verbatim into the ar slot, no Arabic script -> MUST flag
assert.strictEqual(looksUntranslated('Dashboard', AR_SCRIPT_RE), true);

// Actually translated into Arabic script -> MUST NOT flag
assert.strictEqual(looksUntranslated('لوحة القيادة', AR_SCRIPT_RE), false);

// Keyboard-shortcut-style token, legitimately identical across locales -> MUST NOT flag
assert.strictEqual(looksUntranslated('Shift+Enter', AR_SCRIPT_RE), false);
assert.strictEqual(looksUntranslated('Ctrl+K', AR_SCRIPT_RE), false);

// Ordinary hyphenated English is prose, NOT a shortcut -> MUST flag. Only `+` joins a shortcut;
// treating `-` as a separator too would exempt exactly the copy this ratchet exists to catch.
assert.strictEqual(looksUntranslated('Read-only', AR_SCRIPT_RE), true);
assert.strictEqual(looksUntranslated('Drag-and-drop', AR_SCRIPT_RE), true);
assert.strictEqual(looksUntranslated('24-hour', AR_SCRIPT_RE), true);

// A zero-width no-break space (U+FEFF) closes the Arabic Presentation Forms-B block but is not
// Arabic text -> MUST still flag, otherwise a stray invisible character defeats the whole check.
assert.strictEqual(looksUntranslated('Dashboard﻿', AR_SCRIPT_RE), true);

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

// Count fallen below baseline (someone translated more) -> MUST now fail, forcing the baseline
// entry to be lowered in the same PR (issue #2069 part 1: this used to pass silently, banking
// slack that a later regression back up to the stale baseline could occupy with the check still
// reporting `ok` — see the two-step regression fixture below for the exact scenario that happened
// in #2053/PR #2065 + PR #2056).
const bankedSlackErrors = evaluateTranslationRatchet(
  { 'apps/web/src/i18n/locales/ar/nav.json': 10 },
  { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
);
assert.strictEqual(bankedSlackErrors.length, 1);
assert.match(bankedSlackErrors[0], /nav\.json/);
assert.match(bankedSlackErrors[0], /below the recorded baseline of 76/);

// Baseline entry for a file no longer scanned -> MUST fail, telling the author to delete the line.
// The equality rule above cannot catch this: its loop walks `counts`, so a baseline-only key is
// never compared to anything and its allowance survives indefinitely (Devin review on PR #2076).
const staleEntryErrors = evaluateTranslationRatchet(
  { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
  { 'apps/web/src/i18n/locales/ar/nav.json': 76, 'apps/web/src/i18n/locales/ar/deleted.json': 40 },
);
assert.strictEqual(staleEntryErrors.length, 1);
assert.match(staleEntryErrors[0], /deleted\.json/);
assert.match(staleEntryErrors[0], /no longer scanned/);

// A live file matching its baseline alongside it stays clean — the stale-entry rule must not
// start flagging entries that ARE scanned.
assert.deepStrictEqual(
  evaluateTranslationRatchet(
    { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
    { 'apps/web/src/i18n/locales/ar/nav.json': 76 },
  ),
  [],
);

// `validateBaselineShape` renders NaN as NaN, not as `null` (Copilot review on PR #2076):
// `JSON.stringify(NaN)` is `"null"`, which would name a value the file cannot contain. NaN is
// unreachable from the baseline FILE at all — JSON has no NaN literal — but this is an exported
// pure function whose contract should not rest on its one caller being `JSON.parse`.
const nanShapeErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': NaN });
assert.strictEqual(nanShapeErrors.length, 1);
assert.match(nanShapeErrors[0], /is NaN/);

// A file with no recorded baseline entry defaults to an allowance of 0 (new file starts clean)
assert.strictEqual(
  evaluateTranslationRatchet({ 'apps/web/src/i18n/locales/ar/newFile.json': 1 }, {}).length,
  1,
);

// Reproduces the exact #2069 part-1 regression end-to-end: #2053/PR #2065 translated a value in
// ar/encounters.json (count 130 -> 129) but left the baseline at 130; PR #2056 then added one new
// untranslated string (count back up to 130), landing exactly on the stale baseline, and
// check:i18n reported exit 0. With the equality requirement, step one already fails — the
// baseline must be lowered to 129 in the same PR — so there is no free slot left for step two to
// silently reuse.
const step1TranslatedButBaselineUntouched = evaluateTranslationRatchet(
  { 'apps/web/src/i18n/locales/ar/encounters.json': 129 },
  { 'apps/web/src/i18n/locales/ar/encounters.json': 130 },
);
assert.strictEqual(step1TranslatedButBaselineUntouched.length, 1); // MUST fail now, not pass
const step1CorrectlyLowered = { 'apps/web/src/i18n/locales/ar/encounters.json': 129 };
const step2RegressedBackToOldBaseline = evaluateTranslationRatchet(
  { 'apps/web/src/i18n/locales/ar/encounters.json': 130 }, // new untranslated string added
  step1CorrectlyLowered,
);
assert.strictEqual(step2RegressedBackToOldBaseline.length, 1); // MUST be caught, not slide through

// --- validateBaselineShape (issue #2069 part 2) ---

// A well-formed baseline -> MUST pass
assert.deepStrictEqual(
  validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': 76 }),
  [],
);
assert.deepStrictEqual(validateBaselineShape({}), []);

// Top-level shape wrong (not a plain object) -> MUST fail naming the problem
assert.strictEqual(validateBaselineShape(null).length, 1);
assert.strictEqual(validateBaselineShape([1, 2, 3]).length, 1);
assert.strictEqual(validateBaselineShape('not an object').length, 1);
assert.strictEqual(validateBaselineShape(5).length, 1);

// Per-file entry with the wrong type -> MUST fail naming that key.
//
// Measured against the pre-fix code with `count: 999999`, the entries that actually SILENTLY
// BYPASSED enforcement are exactly three: a plain object (`{}`), a non-numeric string (`"x"`),
// and `NaN` — all cases where both `count > allowed` and `count < allowed` evaluate false.
// `[]`, `"5"`, `true` coerce to comparable numbers and were caught; `null` and a missing key
// are caught because `baseline[file] ?? 0` substitutes 0 before the comparison.
//
// The guard rejects every non-integer entry regardless, not just the three that bypassed. A
// baseline of `"5"` or `true` is caught today only by numeric coercion the check never asked
// for and could lose to a refactor, and no such entry is ever intentional — the shape check is
// the thing that should decide, not the coercion rules of `>`.
const nullEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': null });
assert.strictEqual(nullEntryErrors.length, 1);
assert.match(nullEntryErrors[0], /nav\.json/);

const stringEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': '130' });
assert.strictEqual(stringEntryErrors.length, 1);
assert.match(stringEntryErrors[0], /nav\.json/);

const nanEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': NaN });
assert.strictEqual(nanEntryErrors.length, 1);

const objectEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': {} });
assert.strictEqual(objectEntryErrors.length, 1);

const arrayEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': [1, 2] });
assert.strictEqual(arrayEntryErrors.length, 1);

const negativeEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': -1 });
assert.strictEqual(negativeEntryErrors.length, 1);

const nonIntegerEntryErrors = validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': 3.5 });
assert.strictEqual(nonIntegerEntryErrors.length, 1);

// Zero is a legitimate baseline (fully translated file) -> MUST pass
assert.deepStrictEqual(validateBaselineShape({ 'apps/web/src/i18n/locales/ar/nav.json': 0 }), []);

// One bad entry among otherwise-valid ones -> MUST report only the bad one, by name
const mixedErrors = validateBaselineShape({
  'apps/web/src/i18n/locales/ar/nav.json': 76,
  'apps/web/src/i18n/locales/ar/common.json': 'oops',
});
assert.strictEqual(mixedErrors.length, 1);
assert.match(mixedErrors[0], /common\.json/);

// --- findEmptyValues (issue #2073) ---

// A catalog with no empty values -> MUST NOT flag
assert.deepStrictEqual(
  findEmptyValues({ nav: { dashboard: 'Dashboard' }, shortcut: 'Shift+Enter' }, 'en'),
  [],
);

// Reproduces the exact #2073 regression: a leaf value blanked to the empty string. This is the
// case key parity (checkKeyParity) cannot see — the key exists on both sides, so parity holds,
// and it hit both catalogs identically, which the untranslated-value ratchet (comparing en vs.
// ar) also cannot see, since a blanked ar value equal to a blanked en value never "differs".
// findEmptyValues looks at one catalog in isolation, so it catches it regardless.
const blankedErrors = findEmptyValues(
  { encounters: { whisper: { error: '' } } },
  'en',
);
assert.strictEqual(blankedErrors.length, 1);
assert.match(blankedErrors[0], /locales\/en/);
assert.match(blankedErrors[0], /encounters\.whisper\.error/);

// Whitespace-only value -> MUST flag, for a DIFFERENT reason than `""` and worth stating
// precisely (Copilot review on PR #2077). `'   '` is TRUTHY in JavaScript, so a guard like
// `{localError && <p>…}` does mount its paragraph — the element is there, rendering nothing
// visible. So `""` fails by never mounting and `'   '` fails by mounting blank; both leave the
// user with no message, which is what this rule is about, but only the empty case is falsy.
const whitespaceErrors = findEmptyValues({ nav: { dashboard: '   ' } }, 'ar');
assert.strictEqual(whitespaceErrors.length, 1);
assert.match(whitespaceErrors[0], /locales\/ar/);
assert.match(whitespaceErrors[0], /nav\.dashboard/);

// Non-string leaf values (numbers, arrays) are not this rule's concern -> MUST NOT flag
assert.deepStrictEqual(findEmptyValues({ count: 0, list: [] }, 'en'), []);

// Multiple empty values across nested keys -> MUST report each, by locale and dotted path
const multipleEmptyErrors = findEmptyValues(
  { a: { b: '' }, c: '  ', d: 'fine' },
  'ar',
);
assert.strictEqual(multipleEmptyErrors.length, 2);
assert.ok(multipleEmptyErrors.some((e) => /a\.b/.test(e)));
assert.ok(multipleEmptyErrors.some((e) => /^locales\/ar: key "c"/.test(e)));


// --- extractUseTranslationNamespaceArgs (issue #2066) ---

// No-arg call, the only shape the app supports today -> MUST NOT flag
assert.deepStrictEqual(extractUseTranslationNamespaceArgs("const { t } = useTranslation();"), []);

// Whitespace-only parens -> MUST NOT flag
assert.deepStrictEqual(extractUseTranslationNamespaceArgs("const { t } = useTranslation(  );"), []);

// A string namespace argument -> MUST flag, and the flagged text is exactly the argument
assert.deepStrictEqual(
  extractUseTranslationNamespaceArgs("const { t } = useTranslation('encounters');"),
  ["'encounters'"],
);

// Double-quoted namespace argument -> MUST flag
assert.deepStrictEqual(
  extractUseTranslationNamespaceArgs('const { t } = useTranslation("encounters");'),
  ['"encounters"'],
);

// An options-object argument (e.g. { keyPrefix: 'foo' }) is still an argument -> MUST flag,
// since it is not the bare no-arg call the single-namespace app supports.
assert.deepStrictEqual(
  extractUseTranslationNamespaceArgs("useTranslation({ keyPrefix: 'foo' })"),
  ["{ keyPrefix: 'foo' }"],
);

// Multiple calls in one file, only the namespaced ones are reported -> MUST flag exactly those
const mixedFileFixture = `
  function A() { const { t } = useTranslation(); return t('a'); }
  function B() { const { t } = useTranslation('bogusNs'); return t('b'); }
`;
assert.deepStrictEqual(extractUseTranslationNamespaceArgs(mixedFileFixture), ["'bogusNs'"]);

// A plain-English mention of "useTranslation()" inside a comment, with no call parens containing
// an argument, must not be misread as a violation -> MUST NOT flag
assert.deepStrictEqual(
  extractUseTranslationNamespaceArgs('/** call useTranslation() and destructure t */'),
  [],
);


console.log('check-i18n-catalog.spec: ok — all self-test fixtures passed');
