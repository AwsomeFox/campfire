#!/usr/bin/env node
/**
 * CI guard for issue #1453 — every `apps/web/e2e/tests/*.spec.*` file must be
 * picked up by EXACTLY ONE Playwright config, so an orphaned spec file (one
 * matched by zero configs, silently dead) or a duplicated one (matched by more
 * than one config, silently run twice or racing on shared state) cannot recur.
 *
 * Background: `apps/web/pw-unit.config.ts` and `apps/web/playwright.unit.config.ts`
 * both existed with the same `testDir`/`testMatch` shape, but only the latter was
 * ever wired to an npm script or CI job. Every `*.unit.spec.ts` file (currently
 * ~185) silently never ran under ANY config for a long stretch of this repo's
 * history. This check makes that class of defect fail fast instead of rotting
 * unnoticed: it inspects every Playwright config file that targets
 * `apps/web/e2e/tests` and fails if any spec file is matched by zero or by more
 * than one of them.
 *
 * Deliberately static (regex-based), matching this repo's other `check:*`
 * scripts (see check-version-sync.mjs, check-mcp-catalog-sync.mjs) — no ts-node
 * or dynamic `import()` of the .ts config files required.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps/web');
const testsDir = join(webDir, 'e2e/tests');

/** @param {string} literal a `/pattern/flags` source, e.g. `/.*\.unit\.spec\.m?ts/` */
function parseRegexLiteral(literal) {
  const m = literal.match(/^\/(.*)\/([a-z]*)$/s);
  if (!m) throw new Error(`Cannot parse regex literal: ${literal}`);
  return new RegExp(m[1], m[2]);
}

/** Extract a `key: /regex/flags,` value from Playwright config source, if present. */
function extractRegexField(source, key) {
  const re = new RegExp(`${key}:\\s*(/(?:\\\\.|[^/\\\\\\n])*/[a-z]*)\\s*,`);
  const m = source.match(re);
  return m ? parseRegexLiteral(m[1]) : null;
}

function extractStringField(source, key) {
  const re = new RegExp(`${key}:\\s*['"]([^'"]+)['"]`);
  const m = source.match(re);
  return m ? m[1] : null;
}

/** Playwright configs whose testDir resolves to apps/web/e2e/tests. */
function loadTestsConfigs() {
  const configFiles = readdirSync(webDir).filter((f) => f.endsWith('.config.ts'));
  const configs = [];
  for (const file of configFiles) {
    const source = readFileSync(join(webDir, file), 'utf8');
    const testDir = extractStringField(source, 'testDir');
    if (!testDir) continue;
    const resolved = join(webDir, testDir);
    if (resolved !== testsDir) continue;
    const testMatch = extractRegexField(source, 'testMatch');
    const testIgnore = extractRegexField(source, 'testIgnore');
    if (!testMatch) {
      throw new Error(`${file}: targets e2e/tests but has no parseable testMatch`);
    }
    configs.push({ file, testMatch, testIgnore });
  }
  return configs;
}

function listSpecFiles() {
  return readdirSync(testsDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => /\.spec\.(js|ts|mjs|mts)$/.test(name));
}

function main() {
  const configs = loadTestsConfigs();
  if (configs.length === 0) {
    console.error('check-e2e-spec-coverage: found no Playwright config targeting apps/web/e2e/tests');
    process.exit(1);
  }

  const specs = listSpecFiles();
  const errors = [];

  for (const name of specs) {
    const matching = configs.filter(
      ({ testMatch, testIgnore }) => testMatch.test(name) && !(testIgnore && testIgnore.test(name)),
    );
    if (matching.length === 0) {
      errors.push(`${name}: matched by NO config (${configs.map((c) => c.file).join(', ')}) — orphaned, never runs`);
    } else if (matching.length > 1) {
      errors.push(
        `${name}: matched by ${matching.length} configs (${matching.map((c) => c.file).join(', ')}) — runs more than once / configs overlap`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`check-e2e-spec-coverage: ${errors.length} spec file(s) with the wrong config coverage:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nEvery file under apps/web/e2e/tests matching *.spec.* must be picked up by exactly one of: ${configs
        .map((c) => c.file)
        .join(', ')}.`,
    );
    process.exit(1);
  }

  console.log(
    `check-e2e-spec-coverage: OK — ${specs.length} spec file(s) each covered by exactly one of ${configs.length} config(s) (${configs.map((c) => c.file).join(', ')}).`,
  );
}

main();
