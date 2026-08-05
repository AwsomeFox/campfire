#!/usr/bin/env node
/**
 * CI guard for issue #629 and #1940 — translation catalog completeness, i18n surface checks, and JSX text ratchet.
 *
 * 1. Every non-English catalog under `locales/<lng>/` mirrors the English keys.
 * 2. Target feature surfaces must not contain obvious hardcoded user-facing strings.
 * 3. Encounters surface (issue #1940) ratchets against hardcoded plain JSX text nodes using scripts/i18n-jsx-baseline.json.
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

/** @param {Record<string, unknown>} obj @param {string} [prefix] */
function flattenKeys(obj, prefix = '') {
  /** @type {string[]} */
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenKeys(/** @type {Record<string, unknown>} */ (value), path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
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

const parityErrors = checkKeyParity();
const surfaceErrors = checkHardcodedSurfaces();
const ratchetErrors = checkJsxTextRatchet();
const errors = [...parityErrors, ...surfaceErrors, ...ratchetErrors];

if (errors.length > 0) {
  console.error('check-i18n-catalog: failures:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log(
  `check-i18n-catalog: ok — ${listLocaleDirs().length} locale(s), ${flattenKeys(loadMergedLocale(enDir)).length} English keys`,
);
