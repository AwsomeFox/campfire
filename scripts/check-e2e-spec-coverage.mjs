#!/usr/bin/env node
/**
 * CI guard for issue #1453 — every `apps/web/e2e/tests/**` spec file must be
 * picked up by EXACTLY ONE Playwright config, AND that config must actually be
 * invoked by some npm script or CI workflow — so an orphaned spec file (matched
 * by zero configs, matched by more than one, or matched only by a config
 * nothing ever runs) cannot recur.
 *
 * Background: `apps/web/pw-unit.config.ts` and `apps/web/playwright.unit.config.ts`
 * both existed with the same `testDir`/`testMatch` shape, but only the latter was
 * ever wired to an npm script or CI job. Every `*.unit.spec.ts` file (currently
 * ~185) silently never ran under ANY config for a long stretch of this repo's
 * history.
 *
 * This script resolves spec coverage the way Playwright itself does, and every
 * simplifying assumption below has been checked against this repo's actual
 * config files rather than assumed:
 *
 *  - Directory recursion: Playwright scans `testDir` RECURSIVELY. `listSpecFiles()`
 *    walks the full subtree instead of one directory level (a prior version of
 *    this script did not — a spec in a nested folder was invisible to it despite
 *    Playwright running it).
 *  - `testMatch` / `testIgnore` forms: this repo's tests-scoped configs only ever
 *    use a single RegExp literal (verified by inspecting every `*.config.ts` in
 *    apps/web). `extractPatternField()` also supports an array of RegExp
 *    literals (OR'd together) so that form doesn't silently mismatch if
 *    introduced later. A plain glob-STRING `testMatch`/`testIgnore` is not
 *    supported — glob and RegExp semantics differ enough that silently treating
 *    one as the other would be worse than failing loudly, so `extractPatternField`
 *    throws rather than guess if it ever finds a string form here.
 *  - `testDir` default / multiple `testDir`s: Playwright defaults an omitted
 *    `testDir` to the config file's own directory. `resolveConfigTestDir()`
 *    applies that same default rather than skipping such a config. Every
 *    discovered config's resolved `testDir` is then checked against
 *    `apps/web/e2e/tests`: exact match = in scope (as today); a strict ANCESTOR
 *    or DESCENDANT relationship (a config whose recursive scan would partially
 *    overlap `e2e/tests` without being identical to it) throws — this script
 *    does not attempt partial-subtree attribution, and no config in this repo
 *    does that today (each of `playwright.config.ts` / `playwright.unit.config.ts`
 *    / `playwright.first-run.config.ts` / `playwright.subpath.config.ts` targets
 *    exactly one of `e2e/tests`, `e2e/first-run`, or `e2e/subpath` — siblings,
 *    not ancestors/descendants of each other).
 *  - `projects[]` overrides: a project-level `testDir`/`testMatch`/`testIgnore`
 *    would bypass the top-level fields this script reads. `assertNoProjectLevelOverrides()`
 *    throws if any config's `projects` array contains any of those keys. None
 *    of this repo's four configs' `projects` entries do (each project only sets
 *    `name`/`use`) — verified by inspecting every `projects:` block directly.
 *  - File extensions: the two tests-scoped configs' `testMatch` patterns only
 *    ever reference `js|ts|mjs|mts`, matching every real spec file under
 *    `e2e/tests` today (`.ts`/`.mts` only, confirmed by listing the tree).
 *    `auditUnknownSpecLikeFiles()` fails loudly if a `*.test.*`/`*.spec.*` file
 *    ever shows up with a different extension (`.cjs`, `.tsx`, …), instead of
 *    silently excluding it from consideration.
 *  - Config discovery: rather than hardcode a `*.config.ts` filename glob (which
 *    would miss a config using a different naming convention), `discoverConfigFiles()`
 *    scans every top-level `.ts`/`.js`/`.mjs`/`.cjs` file directly under
 *    `apps/web` and keeps the ones whose source actually `import`s
 *    `@playwright/test` and calls `defineConfig(`. This is how `vite.config.ts`
 *    and `eslint.config.mjs` get excluded without a name-based guess, and how a
 *    future `apps/web/e2e.config.ts` would still get picked up.
 *
 * Deliberately static (regex-based text scanning), matching this repo's other
 * `check:*` scripts (see check-version-sync.mjs, check-mcp-catalog-sync.mjs) —
 * no ts-node or dynamic `import()` of the .ts config files required.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const webDir = join(root, 'apps/web');
const testsDir = join(webDir, 'e2e/tests');

/** @param {string} literal a `/pattern/flags` source, e.g. `/.*\.unit\.spec\.m?ts/` */
function parseRegexLiteral(literal) {
  const m = literal.match(/^\/(.*)\/([a-z]*)$/s);
  if (!m) throw new Error(`Cannot parse regex literal: ${literal}`);
  return new RegExp(m[1], m[2]);
}

function extractStringField(source, key) {
  const re = new RegExp(`(?<![\\w.])${key}:\\s*['"]([^'"]+)['"]`);
  const m = source.match(re);
  return m ? m[1] : null;
}

/**
 * Extract a `key: <value>,` field that is a single `/regex/flags` literal or an
 * array of them (OR'd together into one combined RegExp). Returns null if the
 * key is absent. Throws if the key is present but is a glob STRING (or an array
 * with no parseable regex literal in it) — this repo has never used glob-string
 * `testMatch`/`testIgnore`, so silently reinterpreting one as a regex (or vice
 * versa) would risk mismatching rather than failing loudly.
 */
function extractPatternField(source, key) {
  const arrayMatch = source.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  if (arrayMatch) {
    const literals = arrayMatch[1].match(/\/(?:\\.|[^/\\\n])*\/[a-z]*/g);
    if (!literals || literals.length === 0) {
      throw new Error(
        `${key}: array form found but contains no parseable /regex/ literal — extend extractPatternField() before trusting this config`,
      );
    }
    const combined = literals.map((lit) => parseRegexLiteral(lit).source).join('|');
    return new RegExp(combined);
  }

  const singleMatch = source.match(new RegExp(`${key}:\\s*(\\S.*?),?\\s*\\n`));
  if (!singleMatch) return null;
  const value = singleMatch[1].trim();
  if (value.startsWith('/')) return parseRegexLiteral(value.match(/^\/(?:\\.|[^/\\\n])*\/[a-z]*/)[0]);
  throw new Error(
    `${key}: found a non-RegExp, non-array value (${JSON.stringify(value)}) — this script only understands RegExp literals for ${key}; extend extractPatternField() before trusting this config`,
  );
}

/** Extract the bracket-balanced block starting at the first `[` at/after `fromIndex`. */
function extractBalancedBrackets(source, fromIndex) {
  const start = source.indexOf('[', fromIndex);
  if (start === -1) throw new Error("Expected '[' while parsing a projects: field");
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("Unbalanced '[' while parsing a projects: field");
}

/**
 * A `projects[].testDir`/`testMatch`/`testIgnore` override would bypass the
 * top-level fields this script reads, silently invalidating its verdict for
 * that config. Throw rather than silently produce a wrong answer.
 */
function assertNoProjectLevelOverrides(source, file) {
  const idx = source.indexOf('projects:');
  if (idx === -1) return; // no `projects` array: one implicit default project, inherits top-level fields
  const block = extractBalancedBrackets(source, idx);
  if (/\btestDir\b|\btestMatch\b|\btestIgnore\b/.test(block)) {
    throw new Error(
      `${file}: a project entry overrides testDir/testMatch/testIgnore. This script only reads top-level config fields and does not resolve per-project overrides — update check-e2e-spec-coverage.mjs before trusting its output for this config.`,
    );
  }
}

/** Playwright defaults an omitted `testDir` to the directory containing the config file. */
function resolveConfigTestDir(source) {
  const testDir = extractStringField(source, 'testDir') ?? '.';
  return join(webDir, testDir);
}

/**
 * Relationship of `configTestDir` to `target` (`apps/web/e2e/tests`):
 * `'equal'`, `'configIsAncestor'` (target sits somewhere beneath configTestDir —
 * e.g. a config with `testDir: './e2e'`), `'configIsDescendant'` (configTestDir
 * sits somewhere beneath target — e.g. `testDir: './e2e/tests/sub'`), or `null`
 * (unrelated, sibling directories — the common case: e2e/first-run, e2e/subpath).
 */
function overlapKind(configTestDir, target) {
  if (configTestDir === target) return 'equal';
  const targetRelativeToConfig = relative(configTestDir, target);
  if (targetRelativeToConfig && !targetRelativeToConfig.startsWith('..')) return 'configIsAncestor';
  const configRelativeToTarget = relative(target, configTestDir);
  if (configRelativeToTarget && !configRelativeToTarget.startsWith('..')) return 'configIsDescendant';
  return null;
}

/**
 * Every top-level file in apps/web that is an actual Playwright config — found
 * by checking its SOURCE for `@playwright/test` + `defineConfig(`, not by a
 * hardcoded filename pattern, so a differently-named config can't slip past
 * this guard the way `pw-unit.config.ts` slipped past every npm script.
 */
function discoverConfigFiles() {
  return readdirSync(webDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|js|mjs|cjs)$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => {
      const source = readFileSync(join(webDir, name), 'utf8');
      return /from\s+['"]@playwright\/test['"]/.test(source) && /defineConfig\s*\(/.test(source);
    });
}

/** Playwright configs whose testDir resolves to exactly apps/web/e2e/tests. */
function loadTestsConfigs() {
  const configs = [];
  for (const file of discoverConfigFiles()) {
    const source = readFileSync(join(webDir, file), 'utf8');
    assertNoProjectLevelOverrides(source, file);
    const resolvedTestDir = resolveConfigTestDir(source);
    const relation = overlapKind(resolvedTestDir, testsDir);
    if (relation === null) continue; // unrelated testDir (e2e/first-run, e2e/subpath, …) — out of scope
    if (relation !== 'equal') {
      throw new Error(
        `${file}: testDir is ${relation === 'configIsAncestor' ? 'an ANCESTOR of' : 'NESTED INSIDE'} apps/web/e2e/tests, partially overlapping it. This script only attributes whole-directory coverage and cannot correctly split ownership here — update check-e2e-spec-coverage.mjs before trusting its output.`,
      );
    }
    const testMatch = extractPatternField(source, 'testMatch');
    const testIgnore = extractPatternField(source, 'testIgnore');
    if (!testMatch) {
      throw new Error(`${file}: targets e2e/tests but has no parseable testMatch (and Playwright's own default is not implemented here)`);
    }
    configs.push({ file, testMatch, testIgnore });
  }
  return configs;
}

/** Spec-ish extensions every tests-scoped config's testMatch actually references. */
const KNOWN_SPEC_EXTENSIONS = ['js', 'ts', 'mjs', 'mts'];

/** Recursively list every file under `dir`, as POSIX-style paths relative to `dir`. */
function walkRelative(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkRelative(full, base));
    else if (entry.isFile()) out.push(relative(base, full).split('\\').join('/'));
  }
  return out;
}

/** Fail loudly if a test/spec-named file uses an extension no known testMatch covers. */
function auditUnknownSpecLikeFiles(relPaths) {
  const suspicious = relPaths.filter(
    (p) => /\.(test|spec)\.[A-Za-z0-9]+$/.test(p) && !KNOWN_SPEC_EXTENSIONS.some((ext) => p.endsWith(`.${ext}`)),
  );
  if (suspicious.length > 0) {
    throw new Error(
      `Found test/spec-like file(s) with an extension outside ${KNOWN_SPEC_EXTENSIONS.join(
        '/',
      )}, which no known testMatch pattern covers: ${suspicious.join(', ')}. Extend KNOWN_SPEC_EXTENSIONS or check the relevant config's testMatch.`,
    );
  }
}

function listSpecFiles() {
  const all = walkRelative(testsDir);
  auditUnknownSpecLikeFiles(all);
  return all.filter((p) => KNOWN_SPEC_EXTENSIONS.some((ext) => p.endsWith(`.spec.${ext}`)));
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
    console.error(`check-e2e-spec-coverage: ${errors.length} issue(s) with e2e-spec/config coverage:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nEvery file under apps/web/e2e/tests (recursively) matching *.spec.* must be picked up by exactly one of: ${configs
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
