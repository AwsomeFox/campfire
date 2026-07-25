#!/usr/bin/env node
/**
 * Mechanical i18n seam for issue #629 target surfaces.
 * Adds useTranslation + translateApiError to TSX files under audit paths.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACE_ROOTS = [
  'apps/web/src/features/encounters',
  'apps/web/src/features/sessions',
  'apps/web/src/features/compendium',
  'apps/web/src/features/admin',
  'apps/web/src/features/session-zero',
];

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function depthToI18n(fromFile) {
  const rel = fromFile.slice(root.length + 1);
  const depth = rel.split('/').length - 1;
  return '../'.repeat(depth);
}

function ensureImports(src, fromFile) {
  const i18nPath = `${depthToI18n(fromFile)}i18n/locale`;
  let out = src;
  if (!out.includes('useTranslation')) {
    out = out.replace(
      /^(import .+from 'react';?\n)?/m,
      (m) => `${m}import { useTranslation } from 'react-i18next';\n`,
    );
  }
  if (!out.includes('translateApiError')) {
    out = out.replace(
      /(import\s*\{[^}]*)(}\s*from\s*['"][^'"]*lib\/api['"];)/,
      (m, a, b) => (a.includes('translateApiError') ? m : `${a}, translateApiError${b}`),
    );
  }
  if (!out.includes('localeController') && fromFile.includes('inventory')) {
    // inventory already wired manually
  }
  return out;
}

function ensureTHook(src) {
  if (src.includes('useTranslation()')) return src;
  // Insert after first function component opening in default export
  const fnMatch = src.match(/export default function \w+\([^)]*\)\s*\{/);
  if (fnMatch && fnMatch.index !== undefined) {
    const insertAt = fnMatch.index + fnMatch[0].length;
    return `${src.slice(0, insertAt)}\n  const { t } = useTranslation();${src.slice(insertAt)}`;
  }
  // named export function components
  const named = src.match(/export function \w+\([^)]*\)\s*\{/);
  if (named && named.index !== undefined) {
    const insertAt = named.index + named[0].length;
    return `${src.slice(0, insertAt)}\n  const { t } = useTranslation();${src.slice(insertAt)}`;
  }
  return src;
}

const ERROR_FALLBACKS = {
  "Couldn't load encounters.": 'encounters.errors.load',
  "Couldn't create the encounter.": 'encounters.errors.create',
  "Couldn't build a preview.": 'encounters.errors.preview',
  "Couldn't commit the encounter.": 'encounters.errors.commit',
  "Couldn't update links.": 'encounters.errors.updateLinks',
  "Couldn't load this encounter.": 'encounters.errors.loadEncounter',
  "Couldn't upload the map.": 'encounters.errors.uploadMap',
  "Couldn't add combatant.": 'encounters.errors.addCombatant',
  "Couldn't send the check request.": 'encounters.errors.sendCheck',
  "Couldn't roll the check.": 'encounters.errors.rollCheck',
  "Couldn't resolve that action.": 'encounters.errors.resolveAction',
  "Couldn't apply that action.": 'encounters.errors.applyAction',
  "Couldn't load this recap.": 'sessions.errors.loadRecap',
  "Couldn't load the AI scribe.": 'sessions.errors.loadScribe',
  "Couldn't run the scribe.": 'sessions.errors.runScribe',
  "Couldn't save the scribe config.": 'sessions.errors.saveScribe',
  "Couldn't search the compendium.": 'compendium.errors.search',
  "Couldn't load more results.": 'compendium.errors.loadMore',
  "Couldn't update the icon.": 'compendium.errors.updateIcon',
  "Couldn't load this entry.": 'compendium.errors.loadEntry',
};

function replaceErrors(src) {
  let out = src;
  for (const [literal, key] of Object.entries(ERROR_FALLBACKS)) {
    const re = new RegExp(
      `setError\\(err instanceof ApiError \\? err\\.message : "${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`,
      'g',
    );
    out = out.replace(re, `setError(translateApiError(err, t, { fallbackKey: '${key}' }))`);
    const re2 = new RegExp(
      `err instanceof ApiError \\? err\\.message : "${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
      'g',
    );
    out = out.replace(re2, `translateApiError(err, t, { fallbackKey: '${key}' })`);
    const re3 = new RegExp(
      `onError\\?\\.(err instanceof ApiError \\? err\\.message : "${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`,
      'g',
    );
    out = out.replace(re3, `onError?.(translateApiError(err, t, { fallbackKey: '${key}' }))`);
    const re4 = new RegExp(
      `onError\\(err instanceof ApiError \\? err\\.message : "${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)`,
      'g',
    );
    out = out.replace(re4, `onError(translateApiError(err, t, { fallbackKey: '${key}' }))`);
  }
  // Generic pattern for remaining Couldn't ...
  out = out.replace(
    /setError\(err instanceof ApiError \? err\.message : "(Couldn't [^"]+)"\)/g,
    "setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }))",
  );
  out = out.replace(
    /setError\(err instanceof ApiError \? err\.message : "(Couldn't [^"]+)"\)/g,
    "setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }))",
  );
  out = out.replace(
    /err instanceof ApiError \? err\.message : '(Couldn't [^']+)'/g,
    "translateApiError(err, t, { fallbackKey: 'errors.actionFailed' })",
  );
  out = out.replace(
    /err instanceof ApiError \? err\.message : "(Couldn't [^"]+)"/g,
    "translateApiError(err, t, { fallbackKey: 'errors.loadFailed' })",
  );
  out = out.replace(/ErrorNote message="No campaign selected\."/g, "ErrorNote message={t('common.noCampaign')}");
  out = out.replace(/ErrorNote message="No campaign selected."/g, 'ErrorNote message={t(\'common.noCampaign\')}');
  return out;
}

let changed = 0;
for (const relRoot of SURFACE_ROOTS) {
  const abs = join(root, relRoot);
  for (const file of walk(abs)) {
    const rel = file.slice(root.length + 1);
    let src = readFileSync(file, 'utf8');
    const before = src;
    src = ensureImports(src, rel);
    src = ensureTHook(src);
    src = replaceErrors(src);
    if (src !== before) {
      writeFileSync(file, src);
      changed += 1;
      console.log('patched', rel);
    }
  }
}

console.log(`apply-i18n-codemod: ${changed} file(s) updated`);
