/**
 * Card hover accent coherence (issue #644).
 *
 * The design system's primary accent is blurple (--color-accent), and
 * active/selected states already draw from it. But ~dozen list/detail cards
 * hovered amber (`hover:border-amber-500/*`), Search hovered a third color
 * (`hover:border-slate-600`), so hover read like it belonged to a different
 * theme than the chrome around it. The fix introduces a single source of
 * truth — the --cf-accent-hover token consumed by the .cf-card-hover utility
 * — and migrates every drifting site to it.
 *
 * This is a pure source-level unit test (no server, no browser): it reads the
 * raw source files and asserts the invariants that keep hover, active, and
 * selected visually coherent. A regression here is a one-line className that
 * reintroduces the amber drift, so we fail fast on the literal drift strings.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const INDEX_CSS = resolve(ROOT, 'index.css');
const AVATAR_TS = resolve(ROOT, 'features/characters/avatar.ts');

/** Recursively collect source files that may carry className drift. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSources(full, out);
    } else if (/\.(tsx|ts|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = collectSources(ROOT);
const READ = (path: string) => readFileSync(path, 'utf8');

const DRIFT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp; why: string }> = [
  {
    name: 'amber card hover',
    pattern: /hover:border-amber-500\/\d+/,
    why: 'use the .cf-card-hover utility (issue #644) so hover reads from --color-accent, not the retired amber primary',
  },
  {
    name: 'slate card hover',
    pattern: /hover:border-slate-600\b/,
    why: 'use the .cf-card-hover utility (issue #644) so Search hover matches the rest of the app instead of a third slate color',
  },
];

test.describe('Card hover accent coherence (#644)', () => {
  test('the --cf-accent-hover token and .cf-card-hover utility are defined', () => {
    const css = READ(INDEX_CSS);
    // The single source of truth for the hover border color. It MUST be
    // derived from --color-accent (not a hardcoded hue) so a personal accent
    // or theme swap recolors hover automatically alongside active/selected.
    expect(css, '--cf-accent-hover token must exist').toMatch(/--cf-accent-hover:\s*color-mix\(in srgb,\s*var\(--color-accent\)/);
    // The utility class that feature screens compose onto cf-card / cf-inset.
    expect(css, '.cf-card-hover utility must exist').toMatch(/^\.cf-card-hover\s*\{/m);
    expect(css, '.cf-card-hover:hover must consume the token').toMatch(/\.cf-card-hover:hover\s*\{[^}]*var\(--cf-accent-hover\)/);
  });

  test('no source file carries the retired amber or third-color slate hover drift', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      // Skip the index.css comment that documents the migration.
      if (file.endsWith('index.css')) continue;
      const text = READ(file);
      for (const { name, pattern, why } of DRIFT_PATTERNS) {
        const matches = text.match(new RegExp(pattern.source, 'g'));
        if (matches) {
          offenders.push(`${file.replace(ROOT + '/', '')}: ${matches.length}× ${name} (${why})`);
        }
      }
    }
    expect(
      offenders,
      `issue #644 drift must use .cf-card-hover instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  test('every former drift site now composes the .cf-card-hover utility', () => {
    // The acceptance criteria name these screens; each MUST carry the utility
    // so hover stays routed through the token. Counts match the issue evidence.
    const expected: ReadonlyArray<{ file: string; min: number }> = [
      { file: 'features/characters/PartyPage.tsx', min: 1 },
      { file: 'features/npcs/NpcListPage.tsx', min: 1 },
      { file: 'features/npcs/NpcPage.tsx', min: 1 },
      { file: 'features/locations/LocationListPage.tsx', min: 1 },
      { file: 'features/locations/LocationPage.tsx', min: 3 },
      { file: 'features/factions/FactionListPage.tsx', min: 1 },
      { file: 'features/factions/FactionPage.tsx', min: 1 },
      { file: 'features/admin/AdminPage.tsx', min: 1 },
      { file: 'features/search/SearchPage.tsx', min: 1 },
    ];
    for (const { file, min } of expected) {
      const text = READ(join(ROOT, file));
      const count = (text.match(/cf-card-hover/g) || []).length;
      expect(count, `${file} must compose .cf-card-hover on at least ${min} card(s)`).toBeGreaterThanOrEqual(min);
    }
  });

  test('the avatar palette audit is documented so amber is not "fixed" away', () => {
    // avatar.ts is polychromatic BY DESIGN — six distinct hues for
    // distinguishability. The audit (issue #644 acceptance criteria) concluded
    // amber stays as an identity hue (like --cf-crit keeps amber for crits),
    // NOT the app primary. This guards the rationale comment so a future
    // "cleanup" can't silently delete it and reintroduce confusion.
    const text = READ(AVATAR_TS);
    expect(text, 'avatar palette audit note must explain why amber stays').toMatch(/POLYCHROMATIC BY DESIGN/i);
    expect(text, 'audit must reference issue #644').toMatch(/#644/);
    // And the amber tone itself remains (distinguishability hinge).
    expect(text, 'amber avatar tone must remain in the palette').toMatch(/bg-amber-500\/15/);
  });
});
