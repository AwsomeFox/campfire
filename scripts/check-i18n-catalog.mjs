#!/usr/bin/env node
/**
 * CI guard for issue #629, #1940, and #2059 — translation catalog completeness, i18n surface
 * checks, JSX text ratchet, and a per-file untranslated-value ratchet.
 *
 * 1. Every non-English catalog under `locales/<lng>/` mirrors the English keys.
 * 2. Target feature surfaces must not contain obvious hardcoded user-facing strings.
 * 3. Encounters surface (issue #1940) ratchets against hardcoded plain JSX text nodes using scripts/i18n-jsx-baseline.json.
 * 4. Catalog values (issue #2059) ratchet against values that still read as untranslated English
 *    using scripts/i18n-translation-baseline.json. Key parity (#1) only checks that a key exists in
 *    both catalogs, not that the non-English value differs from the English one — this closes that
 *    gap without demanding every existing gap be translated up front.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** @param {string} dir */
function walkSourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkSourceFiles(p));
    } else if (ent.name.endsWith('.tsx')) {
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
 * Non-Latin script detectors, keyed by locale directory name. Presence of a character in the
 * locale's script is a reasonable "this was actually translated" signal for a non-Latin script;
 * it is NOT a reasonable signal for a Latin-script target locale (a correct French translation
 * would look just as "Latin" as untranslated English, so the same proxy would flag everything).
 * Only locales listed here are checked by `checkTranslationRatchet`; a future Latin-script locale
 * would need a different detection strategy, which is out of scope for issue #2059.
 */
const NON_LATIN_SCRIPT_DETECTORS = {
  // Arabic, Arabic Supplement, Arabic Extended-A, Arabic Presentation Forms-A/B.
  ar: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/,
};

// Keyboard-shortcut-style token, e.g. "Shift+Enter", "Ctrl+K", "Cmd+Shift+P" — legitimately
// identical across locales, not prose that needs translating.
const SHORTCUT_LIKE_RE = /^([A-Za-z0-9]+[+-])+[A-Za-z0-9]+$/;

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
 * Pure ratchet evaluation (issue #2059, matching the shape of the #1940 JSX ratchet): fails only
 * when a file's untranslated count RISES above its recorded baseline. A count that falls below
 * baseline is not an error — same as the JSX ratchet, which also only flags increases and leaves
 * lowering the number to a manual, human-initiated baseline edit.
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

const parityErrors = checkKeyParity();
const surfaceErrors = checkHardcodedSurfaces();
const ratchetErrors = checkJsxTextRatchet();
const translationRatchetErrors = checkTranslationRatchet();
const errors = [...parityErrors, ...surfaceErrors, ...ratchetErrors, ...translationRatchetErrors];

if (errors.length > 0) {
  console.error('check-i18n-catalog: failures:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log(
  `check-i18n-catalog: ok — ${listLocaleDirs().length} locale(s), ${flattenKeys(loadMergedLocale(enDir)).length} English keys`,
);
