#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [
  'apps/web/src/features/admin',
  'apps/web/src/features/sessions',
  'apps/web/src/features/compendium',
  'apps/web/src/features/encounters',
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

function patch(src) {
  const fnRe = /^(export )?function (\w+)\([^)]*\)\s*(?::\s*\w+\s*)?\{/gm;
  let m;
  let out = src;
  let offset = 0;
  while ((m = fnRe.exec(src))) {
    const start = m.index + m[0].length;
    const brace = src.indexOf('{', start - 1);
    const bodyStart = brace + 1;
    const chunk = src.slice(bodyStart, bodyStart + 2000);
    if (!/(t\(['"`]|translateApiError\()/.test(chunk)) continue;
    if (/const\s*\{\s*t\s*\}\s*=\s*useTranslation\(\)/.test(chunk.slice(0, 500))) continue;
    const indent = (m[0].match(/^\s*/) || [''])[0] + '  ';
    const insert = `\n${indent}const { t } = useTranslation();`;
    const at = bodyStart;
    out = out.slice(0, at + offset) + insert + out.slice(at + offset);
    offset += insert.length;
    fnRe.lastIndex += insert.length;
  }
  return out;
}

let n = 0;
const files = [...new Set(dirs.flatMap((d) => walk(join(root, d))))];
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  if (!before.includes('useTranslation')) continue;
  const after = patch(before);
  if (after !== before) {
    writeFileSync(file, after);
    n += 1;
    console.log('hook', file.slice(root.length + 1));
  }
}
console.log(`add-t-hooks: ${n} file(s)`);
