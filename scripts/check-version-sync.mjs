#!/usr/bin/env node
/**
 * CI guard for issue #432 — every version surface must agree with the root
 * package.json semver. Fails the build when a workspace package.json, the docs
 * status note, or a hardcoded leftover drifts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expected = rootPkg.version;
if (typeof expected !== 'string' || !/^\d+\.\d+\.\d+/.test(expected)) {
  console.error(`check-version-sync: root package.json version looks wrong: ${expected}`);
  process.exit(1);
}

const workspacePkgs = [
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/schema/package.json',
];

const errors = [];

for (const rel of workspacePkgs) {
  const pkg = JSON.parse(readFileSync(join(root, rel), 'utf8'));
  if (pkg.version !== expected) {
    errors.push(`${rel} version ${pkg.version} !== root ${expected}`);
  }
}

const docsIndex = readFileSync(join(root, 'website/docs/index.md'), 'utf8');
const docsMatch = docsIndex.match(/current release is \*\*v([^*]+)\*\*/);
if (!docsMatch) {
  errors.push('website/docs/index.md missing "current release is **v…**" marker');
} else if (docsMatch[1] !== expected) {
  errors.push(`website/docs/index.md reports v${docsMatch[1]} !== root ${expected}`);
}

// Hardcoded leftovers that historically drifted from package.json.
const forbidden = [
  ['apps/server/src/modules/auth/auth.constants.ts', /VERSION\s*=\s*['"]0\.1\.0['"]/],
  ['apps/server/src/modules/mcp/mcp-tools.ts', /version:\s*['"]0\.1\.0['"]/],
  ['apps/server/src/main.ts', /\.setVersion\(\s*['"]0\.1\.0['"]\s*\)/],
];

for (const [rel, pattern] of forbidden) {
  const src = readFileSync(join(root, rel), 'utf8');
  if (pattern.test(src)) {
    errors.push(`${rel} still hardcodes a stale 0.1.0 version`);
  }
}

if (errors.length > 0) {
  console.error('check-version-sync: version surfaces disagree:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log(`check-version-sync: ok — all surfaces report ${expected}`);
