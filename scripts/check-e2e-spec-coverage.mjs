#!/usr/bin/env node
/**
 * CI guard for issue #1453 — every `apps/web/e2e/tests/*.spec.*` file must be
 * picked up by EXACTLY ONE Playwright config, AND that config must actually be
 * invoked by some npm script or CI workflow — so an orphaned spec file (matched
 * by zero configs, or matched only by a config nothing ever runs) cannot recur.
 *
 * Background: `apps/web/pw-unit.config.ts` and `apps/web/playwright.unit.config.ts`
 * both existed with the same `testDir`/`testMatch` shape, but only the latter was
 * ever wired to an npm script or CI job. Every `*.unit.spec.ts` file (currently
 * ~185) silently never ran under ANY config for a long stretch of this repo's
 * history. Matching-only coverage is not sufficient to catch that: a config with
 * the right `testMatch` that nothing invokes is exactly as dead as no config at
 * all, so this also verifies every tests-scoped config is actually run by a
 * `playwright test` invocation somewhere in `apps/web/package.json`'s scripts or
 * `.github/workflows/ci.yml` — the two places this repo actually runs Playwright.
 *
 * Deliberately static (regex-based), matching this repo's other `check:*`
 * scripts (see check-version-sync.mjs, check-mcp-catalog-sync.mjs) — no ts-node
 * or dynamic `import()` of the .ts config files required.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

/** Playwright's default config filename when no `--config`/`-c` flag is given. */
const DEFAULT_CONFIG = 'playwright.config.ts';

/** Split a shell-ish blob into individual commands on `&&`, `;`, and newlines. */
function splitCommands(text) {
  return text
    .split(/&&|;|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Basenames of every Playwright config actually invoked BROADLY (i.e. with no
 * spec-file filter, so it would run everything the config's own `testMatch`
 * selects) by a `playwright test` command found in `sources`.
 *
 * A `--config`/`-c <path>` flag names the config; its absence means the
 * invocation targets Playwright's default config. Positional (non-flag)
 * arguments after `playwright test` are Playwright's file/pattern filter —
 * `playwright test e2e/tests/pwa-install-offline.spec.ts` (this repo's
 * `test:pwa:e2e` script) runs exactly ONE spec under the default config, not
 * every spec `playwright.config.ts` matches. Crediting that as "the default
 * config is invoked" would let the guard stay green even if the broad
 * `test:e2e` script and the `e2e-web` workflow step (the only UNFILTERED
 * invocations of the default config) were both deleted — the exact
 * silent-orphaning failure #1453 exists to catch, just one level up. So only
 * unfiltered invocations count as "covering" a config; filtered ones are
 * ignored here (they still run fine, they just don't prove the CONFIG's full
 * spec set executes anywhere).
 *
 * GitHub Actions `${{ ... }}` expressions are normalized to one token first so
 * an internal space (e.g. `${{ matrix.shard }}`) isn't mistaken for a
 * filter argument when scanning raw workflow YAML.
 */
function invokedConfigBasenames(sources) {
  const invoked = new Set();
  for (const rawText of sources) {
    const text = rawText.replace(/\$\{\{[^}]*\}\}/g, 'GH_EXPR');
    for (const cmd of splitCommands(text)) {
      const m = cmd.match(/playwright\s+test\b(.*)$/);
      if (!m) continue;
      const tokens = m[1].trim().length ? m[1].trim().split(/\s+/) : [];
      let configFile = DEFAULT_CONFIG;
      let hasFilterArg = false;
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === '--config' || tok === '-c') {
          configFile = basename(tokens[++i] ?? '');
        } else if (tok.startsWith('--config=')) {
          configFile = basename(tok.slice('--config='.length));
        } else if (tok.startsWith('-')) {
          // Some other flag (--shard=1/4, --workers=1, …) — not a spec filter.
        } else {
          hasFilterArg = true; // positional arg = Playwright file/pattern filter
        }
      }
      if (!hasFilterArg) invoked.add(configFile);
    }
  }
  return invoked;
}

/**
 * Every place this repo actually shells out to Playwright: apps/web's own npm
 * scripts (root scripts only ever proxy into these via `npm run <x> -w apps/web`,
 * so the literal `playwright test` invocation always lives here) plus the CI
 * workflow, which also invokes Playwright directly in a couple of steps
 * (`e2e-web`'s sharded run, the first-run project) without going through npm.
 */
function loadInvocationSources() {
  const webPkg = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8'));
  const ciYml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  return [...Object.values(webPkg.scripts ?? {}), ciYml];
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

  // A config can match every spec file perfectly and still be exactly as dead as
  // an orphaned spec if nothing ever runs it — this is the failure mode that let
  // ~185 unit specs sit behind pw-unit.config.ts/playwright.unit.config.ts
  // unexecuted for a long stretch of this repo's history. Verify each tests-scoped
  // config is invoked by an actual `playwright test` command in apps/web's npm
  // scripts or the CI workflow, not just present with a matching `testMatch`.
  const invoked = invokedConfigBasenames(loadInvocationSources());
  for (const { file } of configs) {
    if (!invoked.has(file)) {
      errors.push(
        `${file}: matches spec files but is never invoked by a \`playwright test\` command in apps/web/package.json scripts or .github/workflows/ci.yml — it would run zero specs`,
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
