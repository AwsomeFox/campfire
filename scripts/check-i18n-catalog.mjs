#!/usr/bin/env node
/**
 * CI guard for issue #629 — translation catalog completeness and i18n surface checks.
 *
 * 1. Every non-English catalog under `locales/<lng>/` mirrors the English keys.
 * 2. Target feature surfaces must not contain obvious hardcoded user-facing strings.
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

const ALLOWED_UNTRANSLATED_VALUES = new Set([
  'HP', 'XP', 'AC', 'DC', 'DM', 'AI', 'REST', 'MCP',
  'd4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100',
  'OK', 'JSON', 'REST API', 'ID', 'UUID', 'URL',
]);

const UNTRANSLATED_THRESHOLD = 0.20;

/** @param {Record<string, unknown>} obj @param {string} [prefix] */
function flattenKeyValuePairs(obj, prefix = '') {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenKeyValuePairs(/** @type {Record<string, unknown>} */ (value), path));
    } else if (typeof value === 'string') {
      out[path] = value;
    }
  }
  return out;
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

    // Check for untranslated values identical to English source
    for (const file of files.filter((f) => enFiles.includes(f))) {
      const enMod = JSON.parse(readFileSync(join(enDir, file), 'utf8'));
      const langMod = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const enMap = flattenKeyValuePairs(enMod);
      const langMap = flattenKeyValuePairs(langMod);

      let total = 0;
      let untranslated = 0;
      for (const [k, langVal] of Object.entries(langMap)) {
        const enVal = enMap[k];
        if (enVal !== undefined) {
          total++;
          if (langVal === enVal && !ALLOWED_UNTRANSLATED_VALUES.has(langVal) && langVal.trim().length > 1) {
            untranslated++;
          }
        }
      }

      if (total > 0 && untranslated / total > UNTRANSLATED_THRESHOLD) {
        const pct = Math.round((untranslated / total) * 100);
        errors.push(
          `locales/${lang}/${file}: ${untranslated} of ${total} keys (${pct}%) are untranslated English values (threshold is ${UNTRANSLATED_THRESHOLD * 100}%)`,
        );
      }
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
  { name: "Couldn't …", re: /"Couldn't [^"]+"/ },
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

const parityErrors = checkKeyParity();
const surfaceErrors = checkHardcodedSurfaces();
const errors = [...parityErrors, ...surfaceErrors];

if (errors.length > 0) {
  console.error('check-i18n-catalog: failures:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log(
  `check-i18n-catalog: ok — ${listLocaleDirs().length} locale(s), ${flattenKeys(loadMergedLocale(enDir)).length} English keys`,
);
