#!/usr/bin/env node
/**
 * CI guard for issue #1453 — every `apps/web/e2e/tests/**` spec/test file must
 * be picked up by EXACTLY ONE Playwright config, AND that config must actually
 * be invoked by an unattended npm script or CI workflow — so an orphaned spec
 * file (matched by zero configs, matched by more than one, or matched only by
 * a config nothing automated ever runs) cannot recur.
 *
 * Background: `apps/web/pw-unit.config.ts` and `apps/web/playwright.unit.config.ts`
 * both existed with the same `testDir`/`testMatch` shape, but only the latter was
 * ever wired to an npm script or CI job. Every `*.unit.spec.ts` file (currently
 * ~185) silently never ran under ANY config for a long stretch of this repo's
 * history.
 *
 * ## How coverage is resolved
 *
 * Earlier revisions of this script reimplemented Playwright's own spec
 * resolution (testDir defaults, testMatch/testIgnore as regex vs glob vs array,
 * projects[] overrides, recursion, extensions) with regexes over the config
 * TypeScript source — and every review round found another case it got wrong.
 * That approach is abandoned. Instead:
 *
 *  - For every Playwright config EXCEPT `playwright.config.ts`, this script
 *    asks Playwright itself: `playwright test --list --config <file> --reporter
 *    json` reports exactly which spec files that config would run — no
 *    parsing, authoritative by construction. Verified to run fast with no
 *    build/server needed for `playwright.unit.config.ts` (the actual subject of
 *    #1453), `playwright.first-run.config.ts`, and `playwright.subpath.config.ts`.
 *  - `playwright.config.ts` (the main browser config) is the ONE exception:
 *    ~118 of its spec files call `seed()` (from `e2e/tests/seed.ts`) at MODULE
 *    TOP LEVEL, which reads a file (`e2e/.auth/seed.json`) that only exists
 *    after `global-setup.ts` has seeded a live server over real HTTP.
 *    Playwright's `--list` does not run `globalSetup`, so collection aborts
 *    with ENOENT on the first such file and the WHOLE config reports zero
 *    suites — `--list` cannot enumerate this one config without a live seeded
 *    backend, which is exactly the "needs a running server" cost this check
 *    must avoid (it runs in the fast `lint` CI job). So `playwright.config.ts`
 *    keeps a narrow, minimal regex read of its two top-level fields
 *    (`testMatch`/`testIgnore`, each a single RegExp literal) — see
 *    `narrowFallbackMatches()`. This fallback is intentionally tiny: it throws
 *    rather than silently under-approximate the moment this config grows a
 *    `projects[]` override, an array/glob `testMatch`/`testIgnore`, or a
 *    `testDir` other than exactly `apps/web/e2e/tests` — at that point it must
 *    be revisited (ideally by getting the eager `seed()` calls out of module
 *    scope so `--list` works here too).
 *  - Either way, the on-disk truth — every `*.test.*`/`*.spec.*` file actually
 *    under `apps/web/e2e/tests`, found recursively — is diffed against the
 *    union of what every config claims, so a file matched by zero or by more
 *    than one config still fails regardless of which resolution path found it.
 *
 * ## Invocation check
 *
 * Matching a config's testMatch is not enough on its own — a config with the
 * right shape that nothing ever runs is exactly as dead as no config at all
 * (this is literally how `pw-unit.config.ts` sat unused). `invokedConfigBasenames()`
 * scans `apps/web/package.json`'s scripts and `.github/workflows/ci.yml` for an
 * actual `playwright test [--config|-c <file>]` command and only credits a
 * config when:
 *   - the invocation carries no positional file/pattern filter (a filtered
 *     single-spec command like `test:pwa:e2e`'s
 *     `playwright test e2e/tests/pwa-install-offline.spec.ts` only proves ONE
 *     file runs, not the config's full spec set), and
 *   - the invocation is not an interactive/attended mode (`--ui`, `--debug`) —
 *     `test:e2e:ui`'s `playwright test --ui` opens an interactive UI a human
 *     must drive; it is not something CI or an unattended script executes.
 * Any command this script cannot confidently classify is treated as NOT
 * covering a config — failing closed, per this issue's whole point.
 *
 * Deliberately static text-scanning for the invocation check only (matching
 * this repo's other `check:*` scripts — see check-version-sync.mjs,
 * check-mcp-catalog-sync.mjs); the spec-coverage question is answered by
 * actually running Playwright.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '../..');
const webDir = join(root, 'apps/web');
const testsDir = join(webDir, 'e2e/tests');

/**
 * Path to `@playwright/test`'s own CLI script, resolved from apps/web's
 * package.json rather than shelling out to `npx playwright`. `npx` resolves
 * the "playwright" BIN NAME, which can silently pick up an unrelated,
 * globally- or ancestor-directory-installed `playwright`/`@playwright/test`
 * copy (this bit locally: a stray parent-directory install made `npx
 * playwright` work in a dev sandbox while CI, which only ever installs the
 * `@playwright/test` devDependency this repo actually declares, does not have
 * a bin named exactly "playwright" resolvable the same way and failed).
 * Reading the version this project's own `apps/web/package.json` resolves to
 * is unambiguous and identical in both environments.
 */
function resolvePlaywrightCli() {
  const req = createRequire(join(webDir, 'package.json'));
  const pkgJsonPath = req.resolve('@playwright/test/package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.playwright;
  if (!binRel) {
    throw new Error(`@playwright/test's package.json (${pkgJsonPath}) has no "playwright" bin entry — update resolvePlaywrightCli().`);
  }
  return join(dirname(pkgJsonPath), binRel);
}

/**
 * The one config `--list` cannot collect in this repo without a live seeded
 * server (see the module-level doc comment). Everything else goes through
 * `runPlaywrightList()`.
 */
const NARROW_FALLBACK_CONFIG = 'playwright.config.ts';

// ---------------------------------------------------------------------------
// Config discovery — by SOURCE (imports @playwright/test + calls
// defineConfig()), not a hardcoded `*.config.ts` filename glob, so a
// differently-named config can't slip past this guard the way
// `pw-unit.config.ts` slipped past every npm script.
// ---------------------------------------------------------------------------

function discoverConfigFiles() {
  return readdirSync(webDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|js|mjs|cjs)$/.test(e.name))
    .map((e) => e.name)
    .filter((name) => {
      const source = readFileSync(join(webDir, name), 'utf8');
      return /from\s+['"]@playwright\/test['"]/.test(source) && /defineConfig\s*\(/.test(source);
    });
}

// ---------------------------------------------------------------------------
// Authoritative path: ask Playwright.
// ---------------------------------------------------------------------------

/**
 * Absolute paths of every spec file `configFile` would run, via
 * `playwright test --list --reporter json`. Throws (fails closed) on a
 * non-zero exit or any reported collection error — a config this script
 * cannot get a clean listing from must not be silently skipped.
 */
function runPlaywrightList(configFile) {
  const cli = resolvePlaywrightCli();
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [cli, 'test', '--list', '--config', configFile, '--reporter', 'json'],
      { cwd: webDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    throw new Error(
      `${configFile}: \`playwright test --list\` failed (${err.status != null ? `exit ${err.status}` : err.message}). ` +
        `stderr: ${(err.stderr ?? '').toString().slice(0, 2000)}`,
    );
  }

  const data = JSON.parse(stdout);
  if (data.errors && data.errors.length > 0) {
    throw new Error(
      `${configFile}: \`playwright test --list\` reported ${data.errors.length} collection error(s) — ` +
        `${data.errors.map((e) => e.message).join('; ')}`,
    );
  }
  const rootDir = data.config?.rootDir;
  if (!rootDir) throw new Error(`${configFile}: --list JSON had no config.rootDir`);

  const files = new Set();
  for (const suite of data.suites ?? []) {
    if (suite.file) files.add(resolvePath(rootDir, suite.file));
  }
  return files;
}

/**
 * Keep only the paths that fall within `dir` — a config whose own `testDir`
 * lives elsewhere (`playwright.first-run.config.ts` → `e2e/first-run`,
 * `playwright.subpath.config.ts` → `e2e/subpath`) reports a non-empty
 * `--list`, just for files outside `apps/web/e2e/tests` entirely; those
 * configs are simply out of scope for this guard and must not be treated as
 * "tests-scoped but uninvoked".
 */
function filterWithin(dir, paths) {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return new Set([...paths].filter((p) => p === dir || p.startsWith(prefix)));
}

// ---------------------------------------------------------------------------
// Narrow fallback: playwright.config.ts ONLY. Small and defensive on purpose —
// see the module doc comment for why this one config can't use --list.
// ---------------------------------------------------------------------------

/** @param {string} literal a `/pattern/flags` source, e.g. `/.*\.unit\.spec\.m?ts/` */
function parseRegexLiteral(literal) {
  const m = literal.match(/^\/(.*)\/([a-z]*)$/s);
  if (!m) throw new Error(`Cannot parse regex literal: ${literal}`);
  return new RegExp(m[1], m[2]);
}

/**
 * Find the `/regex/flags` literal immediately following `key:` in `source`.
 * Word-boundary guarded (won't match `myTestMatch:`). Does not depend on
 * reaching end-of-line, so a trailing comma, inline comment, or missing
 * trailing newline after the literal doesn't break it. Throws if the key is
 * present but is an array (`[...]`) or anything other than a bare `/regex/`
 * literal — this fallback only ever supports the single-RegExp shape.
 */
function extractSingleRegexFieldStrict(source, key, { required }) {
  const keyMatch = new RegExp(`(?<![\\w.])${key}:\\s*`).exec(source);
  if (!keyMatch) {
    if (required) throw new Error(`${NARROW_FALLBACK_CONFIG}: no parseable ${key} field found`);
    return null;
  }
  const rest = source.slice(keyMatch.index + keyMatch[0].length);
  if (rest.startsWith('[')) {
    throw new Error(
      `${NARROW_FALLBACK_CONFIG}: ${key} is an array — this narrow fallback only supports a single RegExp literal. Update check-e2e-spec-coverage.mjs (or better: get this config onto \`--list\` by moving eager seed() calls out of module scope).`,
    );
  }
  const literalMatch = rest.match(/^\/(?:\\.|[^/\\\n])*\/[a-z]*/);
  if (!literalMatch) {
    throw new Error(
      `${NARROW_FALLBACK_CONFIG}: ${key} is not a bare /regex/ literal (saw ${JSON.stringify(rest.slice(0, 60).split('\n')[0])}) — this narrow fallback only supports RegExp. Update check-e2e-spec-coverage.mjs.`,
    );
  }
  return parseRegexLiteral(literalMatch[0]);
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
 * Files under `apps/web/e2e/tests` (recursively) that `playwright.config.ts`
 * would run, resolved via a minimal, defensive read of its top-level
 * `testMatch`/`testIgnore` — see the module doc comment for why this one
 * config can't go through `runPlaywrightList()`. Throws rather than silently
 * under-approximating if this config ever grows a `projects[]` override or a
 * `testDir` other than exactly `apps/web/e2e/tests`.
 */
function narrowFallbackMatches(onDiskRelativePaths) {
  const source = readFileSync(join(webDir, NARROW_FALLBACK_CONFIG), 'utf8');

  const projectsIdx = source.indexOf('projects:');
  if (projectsIdx !== -1) {
    const block = extractBalancedBrackets(source, projectsIdx);
    if (/\btestDir\b|\btestMatch\b|\btestIgnore\b/.test(block)) {
      throw new Error(
        `${NARROW_FALLBACK_CONFIG}: a project entry overrides testDir/testMatch/testIgnore — this narrow fallback only reads top-level fields. Update check-e2e-spec-coverage.mjs before trusting its output.`,
      );
    }
  }

  const testDirMatch = new RegExp(`(?<![\\w.])testDir:\\s*['"]([^'"]+)['"]`).exec(source);
  if (!testDirMatch) {
    throw new Error(`${NARROW_FALLBACK_CONFIG}: no parseable testDir field found — this narrow fallback assumes one is present.`);
  }
  const resolvedTestDir = join(webDir, testDirMatch[1]);
  if (resolvedTestDir !== testsDir) {
    throw new Error(
      `${NARROW_FALLBACK_CONFIG}: testDir resolves to ${resolvedTestDir}, not apps/web/e2e/tests — this narrow fallback assumes they're equal. Update check-e2e-spec-coverage.mjs.`,
    );
  }

  const testMatch = extractSingleRegexFieldStrict(source, 'testMatch', { required: true });
  const testIgnore = extractSingleRegexFieldStrict(source, 'testIgnore', { required: false });

  const matches = new Set();
  for (const rel of onDiskRelativePaths) {
    if (testMatch.test(rel) && !(testIgnore && testIgnore.test(rel))) matches.add(join(testsDir, rel));
  }
  return matches;
}

// ---------------------------------------------------------------------------
// On-disk truth.
// ---------------------------------------------------------------------------

/** Extensions any config's testMatch in this repo actually references. */
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

/**
 * Every `*.test.*`/`*.spec.*` file on disk under e2e/tests — the browser
 * config's own `testMatch` (`.*(test|spec)\.(js|ts|mjs|mts)`) accepts both
 * names, so the on-disk truth this script diffs coverage against must too.
 */
function listOnDiskSpecFiles() {
  const all = walkRelative(testsDir);
  auditUnknownSpecLikeFiles(all);
  return all.filter((p) => /\.(test|spec)\.(js|ts|mjs|mts)$/.test(p));
}

// ---------------------------------------------------------------------------
// Invocation check.
// ---------------------------------------------------------------------------

/** Playwright's default config filename when no `--config`/`-c` flag is given. */
const DEFAULT_CONFIG = 'playwright.config.ts';

/** Flags that open an interactive/attended mode — never something CI or an unattended script drives. */
const INTERACTIVE_FLAGS = new Set(['--ui', '--debug']);

/** Split a shell-ish blob into individual commands on `&&`, `||`, `|`, `;`, and newlines. */
function splitCommands(text) {
  return text
    .split(/&&|\|\||\||;|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Quote-aware whitespace tokenizer: `--config "my config.ts"` and `--config="my config.ts"` both work. */
function tokenize(cmd) {
  const tokens = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;
    let token = '';
    while (i < cmd.length && !/\s/.test(cmd[i])) {
      if (cmd[i] === '"' || cmd[i] === "'") {
        const quote = cmd[i];
        i++;
        while (i < cmd.length && cmd[i] !== quote) {
          token += cmd[i];
          i++;
        }
        i++; // skip closing quote (or run off the end — malformed input, best effort)
      } else {
        token += cmd[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

/**
 * Basenames of every Playwright config actually invoked BROADLY (no spec-file
 * filter) and UNATTENDED (no interactive mode) by a `playwright test` command
 * found in `sources`.
 *
 * A `--config`/`-c <path>` flag names the config; its absence means the
 * invocation targets Playwright's default config. Positional (non-flag)
 * arguments after `playwright test` are Playwright's file/pattern filter —
 * `playwright test e2e/tests/pwa-install-offline.spec.ts` (this repo's
 * `test:pwa:e2e` script) runs exactly ONE spec under the default config, not
 * every spec `playwright.config.ts` matches, so it doesn't count. Likewise
 * `--ui`/`--debug` (this repo's `test:e2e:ui`) open an interactive mode a
 * human must drive — never something CI or an unattended script executes —
 * so they don't count either, even though they carry no file filter.
 *
 * GitHub Actions `${{ ... }}` expressions are normalized to one token first so
 * an internal space (e.g. `${{ matrix.shard }}`) isn't mistaken for a filter
 * argument when scanning raw workflow YAML.
 */
function invokedConfigBasenames(sources) {
  const invoked = new Set();
  for (const rawText of sources) {
    const text = rawText.replace(/\$\{\{[^}]*\}\}/g, 'GH_EXPR');
    for (const cmd of splitCommands(text)) {
      const m = cmd.match(/playwright\s+test\b(.*)$/);
      if (!m) continue;
      const tokens = tokenize(m[1]);
      let configFile = DEFAULT_CONFIG;
      let counts = true; // stays true only if unfiltered AND unattended
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok === '--config' || tok === '-c') {
          configFile = basename(tokens[++i] ?? '');
        } else if (tok.startsWith('--config=')) {
          configFile = basename(tok.slice('--config='.length));
        } else if (INTERACTIVE_FLAGS.has(tok)) {
          counts = false; // interactive mode — not automated coverage
        } else if (tok.startsWith('-')) {
          // Some other flag (--shard=1/4, --workers=1, …) — not a spec filter.
        } else {
          counts = false; // positional arg = Playwright file/pattern filter
        }
      }
      if (counts) invoked.add(configFile);
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

// ---------------------------------------------------------------------------

function main() {
  const configFiles = discoverConfigFiles();
  if (!configFiles.includes(NARROW_FALLBACK_CONFIG)) {
    console.error(
      `check-e2e-spec-coverage: expected to find ${NARROW_FALLBACK_CONFIG} among discovered Playwright configs but did not — update NARROW_FALLBACK_CONFIG or investigate.`,
    );
    process.exit(1);
  }

  const onDisk = listOnDiskSpecFiles();

  // configFile -> Set<absolute path>
  const coverageByConfig = new Map();
  for (const file of configFiles) {
    if (file === NARROW_FALLBACK_CONFIG) continue; // handled below
    coverageByConfig.set(file, filterWithin(testsDir, runPlaywrightList(file)));
  }
  coverageByConfig.set(NARROW_FALLBACK_CONFIG, narrowFallbackMatches(onDisk));

  const errors = [];
  for (const rel of onDisk) {
    const abs = join(testsDir, rel);
    const matching = [...coverageByConfig.entries()].filter(([, files]) => files.has(abs)).map(([file]) => file);
    if (matching.length === 0) {
      errors.push(`${rel}: matched by NO config (${configFiles.join(', ')}) — orphaned, never runs`);
    } else if (matching.length > 1) {
      errors.push(`${rel}: matched by ${matching.length} configs (${matching.join(', ')}) — runs more than once / configs overlap`);
    }
  }

  // A config can match every spec file perfectly and still be exactly as dead as
  // an orphaned spec if nothing ever runs it — this is the failure mode that let
  // ~185 unit specs sit behind pw-unit.config.ts/playwright.unit.config.ts
  // unexecuted for a long stretch of this repo's history.
  const testsScopedConfigs = [...coverageByConfig.entries()].filter(([, files]) => files.size > 0).map(([file]) => file);
  const invoked = invokedConfigBasenames(loadInvocationSources());
  for (const file of testsScopedConfigs) {
    if (!invoked.has(file)) {
      errors.push(
        `${file}: matches spec files but is never invoked by an unattended \`playwright test\` command in apps/web/package.json scripts or .github/workflows/ci.yml — it would run zero specs`,
      );
    }
  }

  if (errors.length > 0) {
    console.error(`check-e2e-spec-coverage: ${errors.length} issue(s) with e2e-spec/config coverage:\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\nEvery file under apps/web/e2e/tests (recursively) matching *.test.*/*.spec.* must be picked up by exactly one invoked config.`);
    process.exit(1);
  }

  console.log(
    `check-e2e-spec-coverage: OK — ${onDisk.length} spec file(s) each covered by exactly one of ${testsScopedConfigs.length} invoked config(s) (${testsScopedConfigs.join(', ')}).`,
  );
}

main();
