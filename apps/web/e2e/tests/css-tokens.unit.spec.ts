/**
 * CSS custom-property validation (issue #882).
 *
 * The Storylines beat rail rendered as `borderLeft: '2px solid var(--color-border)'`,
 * but `--color-border` is not a defined token — neither in the design-system
 * cascade (index.css / nocturne.css) nor in the runtime accent override
 * (AuthProvider.tsx, which sets --color-accent / --color-accent-2 and the
 * --cf-accent / --cf-accent-2 aliases). With no value and no fallback, the
 * whole declaration becomes invalid-at-parse-time and the nested-beat visual
 * rail silently disappeared.
 *
 * The canonical divider token is `--color-divider` (index.css:22); `--cf-border`
 * aliases it (index.css:111). This suite pins three things so this regression
 * cannot return:
 *
 *   1. Storylines no longer references the undefined `--color-border` token.
 *   2. No source file anywhere references a custom property that is both
 *      undefined AND missing an inline fallback — the combination that produced
 *      the invalid declaration here. A `var(--undefined)` write is permitted
 *      only when it carries a fallback (`var(--undefined, #fff)`), which makes
 *      the un-resolved case a deliberate, graceful choice rather than a silent
 *      breakage.
 *   3. The canonical divider/rail tokens the fix relies on stay defined.
 *
 * This is a pure unit test — it reads source files and parses CSS, never starts
 * the backend — so it runs under the same Playwright runner as the other
 * `.unit.spec.ts` files without needing the seeded server.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';

/**
 * Resolve from this test file so paths stay stable regardless of how the
 * Playwright runner is invoked (repo root vs apps/web).
 * __dirname is provided by Playwright's CJS transform.
 */
const WEB_ROOT = resolve(__dirname, '../..');
const WEB_SRC = resolve(WEB_ROOT, 'src');
const STORYLINES_PAGE = join(WEB_SRC, 'features', 'storylines', 'StorylinesPage.tsx');

/** Files whose contents can hold `var(--token)` references or token definitions. */
const SCAN_EXTENSIONS = new Set(['.tsx', '.ts', '.css']);
/** Token names that are set at runtime (AuthProvider accent override). */
const RUNTIME_TOKENS = new Set(['--color-accent', '--color-accent-2', '--cf-accent', '--cf-accent-2']);

/**
 * Recursively collect source files under `root` whose extension is in the scan
 * set. Node_modules is never present under src/, so no explicit prune is needed.
 */
function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (SCAN_EXTENSIONS.has(extname(full))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Match `--token-name:` custom-property definitions. A definition must sit at a
 * declaration boundary — start of file, after `{`, after `;`, or after a
 * newline — so that `--x:` appearing inside an arbitrary value (rare, but a
 * valid substring) is not misread as a definition.
 */
const DEFINITION_RE = /(?:^|[;{\n])\s*(--[a-zA-Z0-9-]+)\s*:/g;
/**
 * Match `var(--token-name)` and `var(--token-name, fallback)` references.
 * The final character of each match is either `,` (fallback present) or `)`
 * (no fallback), so hasFallback is derived from that character alone.
 */
const REFERENCE_RE = /var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,|\))/g;

/** All custom-property names defined in the CSS cascade. */
function definedTokens(cssFiles: string[]): Set<string> {
  const defs = new Set<string>();
  for (const file of cssFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(DEFINITION_RE)) defs.add(match[1]);
  }
  for (const t of RUNTIME_TOKENS) defs.add(t);
  return defs;
}

/** Per-file list of `{ token, hasFallback }` for every `var(--token)` reference. */
type Reference = { file: string; token: string; hasFallback: boolean };
function tokenReferences(files: string[]): Reference[] {
  const refs: Reference[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(REFERENCE_RE)) {
      const token = match[1];
      // REFERENCE_RE ends on `,` when a fallback follows, else on `)`.
      const hasFallback = match[0].endsWith(',');
      refs.push({ file, token, hasFallback });
    }
  }
  return refs;
}

/** Path relative to the web app root, for stable failure messages. */
function rel(filePath: string): string {
  return relative(WEB_ROOT, filePath).split('\\').join('/');
}

// --- Pre-computed fixtures (computed once at module load, not per-test) ---

const ALL_FILES = listSourceFiles(WEB_SRC);
const CSS_FILES = ALL_FILES.filter((f) => extname(f) === '.css');
const DEFINED = definedTokens(CSS_FILES);
const REFERENCES = tokenReferences(ALL_FILES);

test.describe('CSS custom-property validation (issue #882)', () => {
  test('StorylinesPage no longer references the undefined --color-border token', () => {
    const text = readFileSync(STORYLINES_PAGE, 'utf8');
    expect(
      text,
      'StorylinesPage must not reference the undefined --color-border token',
    ).not.toContain('--color-border');
    // Canonical divider/rail token WITH fallback (issue #882 acceptance).
    expect(text).toContain('var(--color-divider, rgba(255,255,255,0.08))');
  });

  test('every var(--token) without a fallback resolves to a defined custom property', () => {
    // The regression: an undefined token with no fallback becomes an
    // invalid-at-parse-time declaration and silently drops the whole rule.
    // A `var(--undefined, fallback)` write is allowed because the fallback
    // makes the un-resolved case deliberate and graceful.
    const offenders = REFERENCES.filter(
      (r) => !r.hasFallback && !DEFINED.has(r.token),
    );
    const rendered = offenders.map(
      (r) => `${rel(r.file)} → ${r.token}`,
    );
    expect(
      offenders,
      `Undefined custom properties referenced without a fallback:\n${rendered.join('\n')}`,
    ).toEqual([]);
  });

  test('the canonical divider/rail tokens the Storylines fix relies on stay defined', () => {
    // `--color-divider` is the source of truth; `--cf-border` is its app-facing
    // alias. If either disappears the rail degrades, so both are pinned.
    expect(DEFINED.has('--color-divider'), '--color-divider must be defined').toBe(true);
    expect(DEFINED.has('--cf-border'), '--cf-border must be defined').toBe(true);
  });

  test('CSS cascade files are discoverable (guards the fixture against relocation)', () => {
    // If index.css or nocturne.css moved, the DEFINED set would be empty and
    // the assertions above would vacuously pass. This guard fails loudly so a
    // future relocation can't silently disable the validation.
    expect(CSS_FILES.length, 'at least one CSS source must be scanned').toBeGreaterThan(0);
    const names = CSS_FILES.map((f) => basename(f));
    expect(names).toContain('index.css');
    expect(names).toContain('nocturne.css');
  });
});
