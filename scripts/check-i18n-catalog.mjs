#!/usr/bin/env node
/**
<<<<<<< HEAD
 * CI guard for issue #629, #1940, #2059, #2069, and #2073 — translation catalog completeness,
 * i18n surface checks, JSX text ratchet, and a per-file untranslated-value ratchet.
=======
 * CI guard for issue #629, #1940, #2059, and #2066 — translation catalog completeness, i18n
 * surface checks, JSX text ratchet, a per-file untranslated-value ratchet, and a namespace-
 * reachability check.
>>>>>>> ac46dbfb1 (fix(i18n): stop useTranslation('encounters') from silently disabling t() (#2066))
 *
 * 1. Every non-English catalog under `locales/<lng>/` mirrors the English keys.
 * 2. Target feature surfaces must not contain obvious hardcoded user-facing strings.
 * 3. Encounters surface (issue #1940) ratchets against hardcoded plain JSX text nodes using scripts/i18n-jsx-baseline.json.
 * 4. Catalog values (issue #2059, tightened by #2069) ratchet against values that still read as
 *    untranslated English using scripts/i18n-translation-baseline.json — an exact match against the
 *    baseline, not just a ceiling, and with the baseline's own shape validated (see
 *    `evaluateTranslationRatchet` and `validateBaselineShape`). Key parity (#1) only checks that a
 *    key exists in both catalogs, not that the non-English value differs from the English one —
 *    this closes that gap without demanding every existing gap be translated up front.
 * 5. No leaf value in any catalog may be the empty string or whitespace-only (issue #2073). This
 *    is a hard failure, not a ratchet: there is no catalog entry for which `""` is intended
 *    content, and a real key deprecation removes the key rather than blanking it. Key parity (#1)
 *    and the untranslated-value ratchet (#4) both compare two catalogs to each other, so neither
 *    can see a value blanked identically on both sides of the comparison — see `checkEmptyValues`.
 * 6. No `useTranslation(...)` call anywhere in `apps/web/src` may pass a namespace argument
 *    (issue #2066), because `apps/web/src/i18n/index.ts` registers only one namespace
 *    (`translation`). Checks 1-5 all inspect catalogs; a component that asks for a namespace
 *    that was never registered still passes every one of them while every `t()` call in it
 *    silently returns its English default forever — this is the only check that catches that.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = join(root, 'apps/web/src/i18n/locales');
const enDir = join(localesRoot, 'en');

const SURFACE_ROOTS = [
  'apps/web/src/features/inventory',
  'apps/web/src/features/encounters',
  'apps/web/src/features/sessions',
  'apps/web/src/features/compendium',
  'apps/web/src/features/admin',
  'apps/web/src/features/session-zero',
];

/**
 * Single recursive walk of a catalog object into leaf `[keyPath, value]` pairs. Both
 * `flattenKeys` (key parity, #629) and the untranslated-value ratchet (#2059) build on this
 * one traversal instead of each re-implementing catalog walking.
 * @param {Record<string, unknown>} obj @param {string} [prefix]
 * @returns {[string, unknown][]}
 */
function flattenEntries(obj, prefix = '') {
  /** @type {[string, unknown][]} */
  const entries = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenEntries(/** @type {Record<string, unknown>} */ (value), path));
    } else {
      entries.push([path, value]);
    }
  }
  return entries;
}

/** @param {Record<string, unknown>} obj @param {string} [prefix] */
function flattenKeys(obj, prefix = '') {
  return flattenEntries(obj, prefix)
    .map(([key]) => key)
    .sort();
}

/** @param {string} dir */
function loadMergedLocale(dir) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const mod = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    Object.assign(out, mod);
  }
  return out;
}

function listLocaleDirs() {
  return readdirSync(localesRoot).filter((name) => {
    const p = join(localesRoot, name);
    return name !== 'en' && statSync(p).isDirectory();
  });
}

function checkKeyParity() {
  const en = loadMergedLocale(enDir);
  const enKeys = flattenKeys(en);
  const errors = [];

  for (const lang of listLocaleDirs()) {
    const dir = join(localesRoot, lang);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const enFiles = readdirSync(enDir).filter((f) => f.endsWith('.json'));
    const missingFiles = enFiles.filter((f) => !files.includes(f));
    const extraFiles = files.filter((f) => !enFiles.includes(f));
    if (missingFiles.length > 0) {
      errors.push(`locales/${lang}: missing JSON files: ${missingFiles.join(', ')}`);
    }
    if (extraFiles.length > 0) {
      errors.push(`locales/${lang}: unexpected JSON files: ${extraFiles.join(', ')}`);
    }

    const catalog = loadMergedLocale(dir);
    const keys = flattenKeys(catalog);
    const missing = enKeys.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !enKeys.includes(k));
    if (missing.length > 0) {
      errors.push(`locales/${lang}: missing ${missing.length} keys (e.g. ${missing.slice(0, 5).join(', ')})`);
    }
    if (extra.length > 0) {
      errors.push(`locales/${lang}: extra ${extra.length} keys (e.g. ${extra.slice(0, 5).join(', ')})`);
    }
  }

  return errors;
}

/**
<<<<<<< HEAD
 * Pure hard-failure rule (issue #2073): no leaf value in a catalog may be the empty string or
 * whitespace-only. Reports the offending locale and dotted key path.
 *
 * Deliberately narrow: this is NOT a "value must be non-trivial" heuristic, not a minimum
 * length, and not a "value differs between en and ar" rule — some keys legitimately match across
 * locales (proper nouns, symbols), and that broader rule would be noise for no extra coverage
 * over the empty-string case. Empty is unambiguous: real content is never `""`, and a real key
 * deprecation removes the key rather than blanking it, so there is no ratchet/baseline here —
 * every occurrence is a bug the moment it lands. Unlike key parity (#1) and the untranslated-value
 * ratchet (#4), which both compare two catalogs to each other, this looks at one catalog in
 * isolation, so it can see a value blanked identically on both sides of that comparison.
 * @param {Record<string, unknown>} catalog
 * @param {string} locale
 * @returns {string[]}
 */
export function findEmptyValues(catalog, locale) {
  const errors = [];
  for (const [key, value] of flattenEntries(catalog)) {
    if (typeof value === 'string' && value.trim() === '') {
      errors.push(`locales/${locale}: key "${key}" is empty or whitespace-only (${JSON.stringify(value)})`);
    }
  }
  return errors;
}

function checkEmptyValues() {
  const errors = [];
  for (const lang of ['en', ...listLocaleDirs()]) {
    const catalog = loadMergedLocale(join(localesRoot, lang));
    errors.push(...findEmptyValues(catalog, lang));
  }
  return errors;
}

/** @param {string} dir */
function walkSourceFiles(dir) {
=======
 * @param {string} dir
 * @param {string[]} [extensions] file extensions to include (default `.tsx` only, the
 *   pre-#2066 behavior every existing caller relies on).
 */
function walkSourceFiles(dir, extensions = ['.tsx']) {
>>>>>>> ac46dbfb1 (fix(i18n): stop useTranslation('encounters') from silently disabling t() (#2066))
  /** @type {string[]} */
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkSourceFiles(p, extensions));
    } else if (extensions.some((ext) => ent.name.endsWith(ext))) {
      out.push(p);
    }
  }
  return out;
}

const HARDCODED_PATTERNS = [
  { name: 'ErrorNote message=', re: /ErrorNote\s+message="[^"]+"/ },
  { name: 'EmptyState title=', re: /EmptyState[^>]*title="[^"]+"/ },
  { name: 'EmptyState hint=', re: /EmptyState[^>]*hint="[^"]+"/ },
  { name: 'Couldn\'t …', re: /"Couldn't [^"]+"/ },
  { name: 'No campaign selected', re: /"No campaign selected\."/ },
  { name: 'setError err.message fallback', re: /err instanceof ApiError\s*\?\s*err\.message\s*:/ },
];

function checkHardcodedSurfaces() {
  const errors = [];
  for (const relRoot of SURFACE_ROOTS) {
    const abs = join(root, relRoot);
    for (const file of walkSourceFiles(abs)) {
      const rel = file.slice(root.length + 1);
      const src = readFileSync(file, 'utf8');
      if (!src.includes('useTranslation')) {
        errors.push(`${rel}: missing useTranslation() import/hook`);
      }
      for (const { name, re } of HARDCODED_PATTERNS) {
        if (re.test(src)) {
          errors.push(`${rel}: hardcoded pattern ${name}`);
        }
      }
    }
  }
  return errors;
}

/**
 * Scans JSX source code for hardcoded user-facing plain text strings in text nodes (issue #1940).
 * Excludes attributes (data-testid, className, aria-*), numbers, dice notation (1d8+4, d20), punctuation, and t() calls.
 * @param {string} src
 * @returns {string[]} List of matched hardcoded text strings
 */
export function extractJsxTextNodes(src) {
  const matches = [];
  const textNodeRegex = />([^<>{}\r\n]+)</g;
  let match;
  while ((match = textNodeRegex.exec(src)) !== null) {
    const raw = match[1];
    const text = raw.trim();
    if (!text) continue;
    if (/^[\d\s\-_.,/\\()!?:;+|#%&*=<>'"✓✗ℹ️—–…]+$/.test(text)) continue;
    if (/^\d*d\d+([+-]\d+)?$/i.test(text)) continue;
    if (!/[a-zA-Z]{2,}/.test(text)) continue;
    matches.push(text);
  }
  return matches;
}

function checkJsxTextRatchet() {
  const errors = [];
  const baselinePath = join(root, 'scripts/i18n-jsx-baseline.json');
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    errors.push(`missing or invalid scripts/i18n-jsx-baseline.json: ${err.message}`);
    return errors;
  }

  const encDir = join(root, 'apps/web/src/features/encounters');
  for (const file of walkSourceFiles(encDir)) {
    const rel = file.slice(root.length + 1);
    const src = readFileSync(file, 'utf8');
    const nodes = extractJsxTextNodes(src);
    const allowedCount = baseline[rel] ?? 0;
    if (nodes.length > allowedCount) {
      errors.push(
        `${rel}: has ${nodes.length} hardcoded JSX text node(s), exceeding baseline limit of ${allowedCount}. ` +
          `New hardcoded strings (e.g. "${nodes[0]}") must be translated with t() / useTranslation.`,
      );
    }
  }
  return errors;
}

/**
 * Extracts every argument passed to `useTranslation(...)` in a source file (issue #2066).
 * Returns the raw (trimmed) argument text for each call that passes ANY argument — a namespace
 * string, an options object, anything other than an empty parameter list.
 * @param {string} src
 * @returns {string[]}
 */
export function extractUseTranslationNamespaceArgs(src) {
  /** @type {string[]} */
  const args = [];
  const callRe = /\buseTranslation\s*\(\s*([^)]*?)\s*\)/g;
  let match;
  while ((match = callRe.exec(src)) !== null) {
    const arg = match[1].trim();
    if (arg.length > 0) args.push(arg);
  }
  return args;
}

/**
 * Guard for issue #2066. `apps/web/src/i18n/index.ts` registers exactly ONE i18next namespace
 * (`translation`) — no `ns`, `defaultNS`, or `fallbackNS`. Calling `useTranslation('someNs')`
 * (or passing any other argument) asks react-i18next to resolve against a namespace that was
 * never registered: every `t()` call in that file then misses and falls straight through to its
 * inline default, in EVERY locale, forever — silently, because the two-argument `t(key,
 * fallback)` form never lets a raw catalog key surface on screen to reveal the break. Key parity
 * (#629), the JSX text ratchet (#1940), and the untranslated-value ratchet (#2059) all inspect
 * the CATALOGS; none of them can tell whether a component can actually reach one. This is the
 * only check that does — a straight fail, not a ratchet, because there is no legitimate call
 * shape to grandfather in while the app registers a single namespace.
 */
function checkUseTranslationNamespaceArgument() {
  /** @type {string[]} */
  const errors = [];
  const srcDir = join(root, 'apps/web/src');
  for (const file of walkSourceFiles(srcDir, ['.ts', '.tsx'])) {
    const rel = file.slice(root.length + 1);
    const src = readFileSync(file, 'utf8');
    for (const arg of extractUseTranslationNamespaceArgs(src)) {
      errors.push(
        `${rel}: useTranslation(${arg}) passes an argument, but apps/web/src/i18n/index.ts registers ` +
          `only a single "translation" namespace (no ns/defaultNS/fallbackNS). A namespace argument here ` +
          `silently disables every t() call in this file — each one misses the unregistered namespace and ` +
          `falls through to its inline default, in every locale, forever (issue #2066). Drop the argument: ` +
          `useTranslation().`,
      );
    }
  }
  return errors;
}

/**
 * Non-Latin script detectors, keyed by locale directory name. Presence of a character in the
 * locale's script is a reasonable "this was actually translated" signal for a non-Latin script;
 * it is NOT a reasonable signal for a Latin-script target locale (a correct French translation
 * would look just as "Latin" as untranslated English, so the same proxy would flag everything).
 * Only locales listed here are checked by `checkTranslationRatchet`; a future Latin-script locale
 * would need a different detection strategy, which is out of scope for issue #2059.
 */
export const NON_LATIN_SCRIPT_DETECTORS = {
  // Arabic, Arabic Supplement, Arabic Extended-A, Arabic Presentation Forms-A/B. Forms-B stops at
  // U+FEFC, the last assigned ligature — deliberately NOT U+FEFF, which ends the block but is
  // ZWNBSP/BOM. A stray zero-width character is not evidence that a value was translated.
  ar: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ]/,
};

// Keyboard-shortcut-style token, e.g. "Shift+Enter", "Ctrl+K", "Cmd+Shift+P" — legitimately
// identical across locales, not prose that needs translating. Only `+` joins a shortcut; allowing
// `-` here would also exempt ordinary hyphenated English ("Read-only", "Drag-and-drop", "24-hour"),
// which is exactly the prose this ratchet exists to catch.
const SHORTCUT_LIKE_RE = /^([A-Za-z0-9]+\+)+[A-Za-z0-9]+$/;

/**
 * Proxy for "this catalog value still reads as untranslated English" (issue #2059). A value
 * counts as untranslated when, after stripping `{{interpolation}}` placeholders:
 *  - what remains still contains real Latin-letter text (so pure numbers, symbols, punctuation,
 *    or a placeholder-only value like "{{count}}" are NOT counted — nothing to translate there);
 *  - it is not a keyboard-shortcut-style token like "Shift+Enter" (NOT counted — identical
 *    on purpose); and
 *  - the raw (unstripped) value contains none of the target locale's script characters.
 *
 * Deliberately NOT exempted: proper nouns, brand names, and other values an author judges should
 * stay identical to English. Those still increment the count. The ratchet (not this function) is
 * what keeps that from forcing a bogus translation — an author can raise the specific file's
 * baseline in scripts/i18n-translation-baseline.json with the same one-line, human-reviewed edit
 * the existing JSX ratchet (scripts/i18n-jsx-baseline.json, issue #1940) already uses, instead of
 * fabricating target-language text to satisfy the check.
 * @param {unknown} value
 * @param {RegExp} scriptRe
 */
export function looksUntranslated(value, scriptRe) {
  if (typeof value !== 'string') return false;
  const stripped = value.replace(/\{\{[^}]*\}\}/g, '').trim();
  if (!/[A-Za-z]/.test(stripped)) return false;
  if (SHORTCUT_LIKE_RE.test(stripped)) return false;
  return !scriptRe.test(value);
}

/**
 * Pure count of untranslated leaf values shared between an English catalog and a target-locale
 * catalog for one file, keyed by the same leaf path (via `flattenEntries`, the same traversal
 * `checkKeyParity` uses). Keys missing from either side are skipped here — `checkKeyParity`
 * already reports those.
 * @param {Record<string, unknown>} enCatalog
 * @param {Record<string, unknown>} targetCatalog
 * @param {RegExp} scriptRe
 */
export function countUntranslatedInCatalog(enCatalog, targetCatalog, scriptRe) {
  const enEntries = new Map(flattenEntries(enCatalog));
  let count = 0;
  for (const [key, value] of flattenEntries(targetCatalog)) {
    if (!enEntries.has(key)) continue;
    if (looksUntranslated(value, scriptRe)) count += 1;
  }
  return count;
}

/**
 * Pure ratchet evaluation (issue #2059; tightened by #2069). Requires the recorded baseline to
 * EXACTLY match the current count, both directions:
 *  - a RISE above baseline fails, same as before — the ordinary regression case;
 *  - a FALL below baseline now also fails, forcing the baseline entry to be lowered in the same PR.
 *
 * The fall case closes "banked slack" (#2069 part 1): under the old rise-only rule, a PR that
 * translated a value but left the baseline untouched banked headroom, and a later PR could add a
 * new untranslated string back up to that same baseline with the check reporting `ok` the whole
 * time — this is exactly what happened across #2053/PR #2065 and #2056 within hours of the
 * ratchet (#2059) landing. Requiring equality means the baseline can never drift into an upper
 * bound that overstates the real count, so there is no headroom left to bank.
 *
 * This is the simpler of the fixes #2069 lists (vs. e.g. auto-regenerating and committing the
 * baseline): it needs no new write-back mechanism, and every translation PR touching the baseline
 * file is a readable signal of what changed, not a maintenance cost worth avoiding.
 *
 * Deliberately NOT applied here to the #1940 JSX ratchet (`scripts/i18n-jsx-baseline.json`), which
 * has the identical rise-only gap per #2069's own text — that is a distinct rule/baseline file and
 * out of scope for this fix.
 * @param {Record<string, number>} counts current untranslated count per file (relative path)
 * @param {Record<string, number>} baseline recorded allowed count per file (relative path)
 */
export function evaluateTranslationRatchet(counts, baseline) {
  /** @type {string[]} */
  const errors = [];
  for (const [file, count] of Object.entries(counts)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      errors.push(
        `${file}: ${count} untranslated value(s) (no target-script characters detected), exceeding baseline of ${allowed}. ` +
          `Translate the new/changed value(s), or if staying identical to English is deliberate, ` +
          `raise this file's entry in scripts/i18n-translation-baseline.json in the same PR.`,
      );
    } else if (count < allowed) {
      errors.push(
        `${file}: ${count} untranslated value(s) (no target-script characters detected), below the recorded baseline of ${allowed}. ` +
          `Lower this file's entry in scripts/i18n-translation-baseline.json to ${count} in the same PR — ` +
          `leaving a stale, higher baseline banks slack that a later regression could silently reuse (issue #2069).`,
      );
    }
  }
  // A baseline entry for a file that is no longer scanned is the SAME banked-slack loophole
  // wearing a different hat, and the equality rule above cannot see it: that loop walks `counts`,
  // so a key present only in the baseline is never compared to anything. Delete or rename a
  // locale file and its allowance survives forever; recreate that path later and untranslated
  // values up to the old number pass unchallenged.
  for (const file of Object.keys(baseline)) {
    if (file in counts) continue;
    errors.push(
      `${file}: has a baseline entry of ${baseline[file]} but is no longer scanned ` +
        `(the file was deleted or renamed, or its locale has no script detector). ` +
        `Remove this line from scripts/i18n-translation-baseline.json — a stale allowance is ` +
        `reusable headroom if that path ever comes back (issue #2069).`,
    );
  }
  return errors;
}

/**
 * Validates that a parsed baseline is a plain object mapping file paths to non-negative integers
 * (issue #2069 part 2). `evaluateTranslationRatchet`'s `count > allowed` / `count < allowed`
 * comparisons are silently false for every count when `allowed` is `NaN`, a numeric string, an
 * object, an array, etc. (`5 > {}` and `5 < {}` are both `false`), which turns a single malformed
 * hand-edit — the baseline file's documented workflow — into "this file is no longer enforced" while
 * the check still reports `ok`. Reject that shape up front, naming the bad key, instead of letting
 * a silently-false comparison swallow it.
 * @param {unknown} baseline
 * @returns {string[]} errors; empty when the shape is valid
 */
export function validateBaselineShape(baseline) {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    const gotType = baseline === null ? 'null' : Array.isArray(baseline) ? 'an array' : typeof baseline;
    return [
      `scripts/i18n-translation-baseline.json: expected a JSON object mapping file paths to non-negative integers, got ${gotType}`,
    ];
  }
  /** @type {string[]} */
  const errors = [];
  for (const [file, value] of Object.entries(baseline)) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      // NOT `JSON.stringify` alone: it renders `NaN` as `null`, so the message would name a
      // value the file does not contain and send the reader looking for the wrong entry.
      const shown = typeof value === 'number' && Number.isNaN(value) ? 'NaN' : JSON.stringify(value);
      errors.push(
        `scripts/i18n-translation-baseline.json: entry "${file}" is ${shown}, expected a non-negative integer`,
      );
    }
  }
  return errors;
}

function checkTranslationRatchet() {
  const baselinePath = join(root, 'scripts/i18n-translation-baseline.json');
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    return [`missing or invalid scripts/i18n-translation-baseline.json: ${err.message}`];
  }

  const shapeErrors = validateBaselineShape(baseline);
  if (shapeErrors.length > 0) {
    return shapeErrors;
  }

  const enFiles = readdirSync(enDir).filter((f) => f.endsWith('.json'));
  /** @type {Record<string, number>} */
  const counts = {};

  for (const lang of listLocaleDirs()) {
    const scriptRe = NON_LATIN_SCRIPT_DETECTORS[lang];
    if (!scriptRe) continue;
    const dir = join(localesRoot, lang);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && enFiles.includes(f));
    for (const file of files) {
      const enCatalog = JSON.parse(readFileSync(join(enDir, file), 'utf8'));
      const targetCatalog = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const rel = `apps/web/src/i18n/locales/${lang}/${file}`;
      counts[rel] = countUntranslatedInCatalog(enCatalog, targetCatalog, scriptRe);
    }
  }

  return evaluateTranslationRatchet(counts, baseline);
}

function main() {
  const parityErrors = checkKeyParity();
  const surfaceErrors = checkHardcodedSurfaces();
  const ratchetErrors = checkJsxTextRatchet();
  const translationRatchetErrors = checkTranslationRatchet();
  const emptyValueErrors = checkEmptyValues();
  const namespaceErrors = checkUseTranslationNamespaceArgument();
  const errors = [
    ...parityErrors,
    ...surfaceErrors,
    ...ratchetErrors,
    ...translationRatchetErrors,
    ...emptyValueErrors,
    ...namespaceErrors,
  ];

  if (errors.length > 0) {
    console.error('check-i18n-catalog: failures:\n- ' + errors.join('\n- '));
    process.exit(1);
  }

  console.log(
    `check-i18n-catalog: ok — ${listLocaleDirs().length} locale(s), ${flattenKeys(loadMergedLocale(enDir)).length} English keys`,
  );
}

// Only scan the repository when run as a script. `check-i18n-catalog.spec.mjs` imports the pure
// helpers above; without this guard that import also runs the full repository check, so a fixture
// suite could not report on its own.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
