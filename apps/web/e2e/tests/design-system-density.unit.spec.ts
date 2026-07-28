/**
 * Design-system density consolidation (issue #674; `xs` step + codemod, #1683).
 *
 * Nocturne (.card/.btn/.input) and cf-* once drifted on radii, padding, and
 * elevation. The canonical ramp lives in index.css + ui.tsx primitives with
 * xs/compact/default/comfortable density. This suite pins the invariants so a
 * one-line Tailwind override cannot reintroduce competing geometry.
 *
 * Issue #1683 added `xs` specifically to retire the `!min-h-0 !py-*` height-
 * shrink idiom (305 sites, #1683's own count) — the risk that idiom carries is
 * a touch target with NO floor at all. `xs` exists so density-heavy toolbars
 * still clear a floor. Two invariants protect that:
 *   - the floor itself (`--cf-density-xs-control-min-height`) can never drop
 *     below 24px (WCAG 2.2 SC 2.5.8) — see the token-value test below;
 *   - the retired `!important` idiom itself is banned repo-wide, not just on
 *     `cf-btn` (the old, narrower drift pattern) — see the broadened geometry
 *     scan below, which is what "no !important geometry override outside the
 *     density API" (#1683's named test) actually means mechanically.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../src');
const INDEX_CSS = resolve(ROOT, 'index.css');
const NOCTURNE_CSS = resolve(ROOT, 'nocturne.css');
const UI_TSX = resolve(ROOT, 'components/ui.tsx');
const DENSITY_TS = resolve(ROOT, 'components/density.ts');

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
    name: 'ad-hoc cf-card padding',
    pattern: /['"`][^'"`\n]*\bcf-card\s[^'"`\n]*\bp-\d/,
    why: 'compose <Card density="…"> instead of cf-card + Tailwind padding (issue #674)',
  },
  {
    name: 'important card padding override',
    pattern: /<Card[^>]*className="[^"]*!p-/,
    why: 'use the Card density or flush props instead of !p-* overrides (issue #674)',
  },
  {
    name: 'btn geometry override',
    pattern: /cf-btn[^"'\n]*!min-h-0/,
    why: 'use <Btn density="compact"> instead of !min-h-0 / !py-* on cf-btn (issue #674)',
  },
  {
    name: 'seg-opt floor override',
    pattern: /seg-opt[^"'\n]*!min-h-0/,
    why: 'seg-opt sits outside the cf-density ramp and pins its own 24px WCAG 2.2 SC 2.5.8 ' +
      'floor directly in nocturne.css (issue #1693) — !min-h-0 zeroes that floor with ' +
      '!important and nothing in the ramp catches the regression',
  },
];

/**
 * The retired height-shrink idiom (issue #1683): `!min-h-0` and the small
 * `!py-*` steps it was always paired with to fake a denser control. Two forms:
 * a plain string attribute (`className="…"`) and a template-literal
 * expression (`className={\`…\`}`) — the codemod that retired the first 305
 * sites only rewrote literal double-quoted strings, and a follow-up grep
 * found five more sites hiding behind a template literal or ternary (fixed
 * by hand in #1683; this second branch is what would have caught them
 * mechanically). A fully dynamic expression — a ternary between two PLAIN
 * string literals, e.g. `className={compact ? '!py-1 …' : undefined}` — is
 * NOT matched by either branch; that shape has to be caught by review, same
 * as this codebase's other source-scanning guards (e.g. css-tokens.unit.spec.ts)
 * already accept for their own regex-vs-real-parser tradeoff.
 */
const RETIRED_HEIGHT_SHRINK_RE =
  /(className|selectClassName)="[^"]*(?:!min-h-0|!py-(?:0(?:\.5)?|1(?:\.5)?|2))\b[^"]*"|(className|selectClassName)=\{`[^`]*(?:!min-h-0|!py-(?:0(?:\.5)?|1(?:\.5)?|2))\b[^`]*`\}/g;

/**
 * Documented, reviewed exceptions (#1683) — decorative labels and one bespoke
 * pre-existing component, none of which compose the shared density API:
 *   - `cf-chip` env/status pills and bare `tag` badges are non-interactive
 *     (no onClick, no role=button) — the touch-target floor this issue exists
 *     to protect does not apply to them.
 *   - `.seg-opt` (RsvpChooser's radiogroup options) is a Nocturne component
 *     with its own geometry, not built on cf-btn/cf-card — pulling it onto
 *     the density ramp is out of scope here; flagged to the coordinator as a
 *     followup candidate instead of forced through.
 * Any NEW match outside these files must add its own `xs`/`compact` density
 * (or a documented reason here) — this allowlist must not grow silently.
 */
const HEIGHT_SHRINK_ALLOWED_FILES = new Set(
  ['features/admin/OidcCard.tsx', 'features/admin/StorageCard.tsx', 'features/characters/CharacterSheetNav.tsx', 'features/sessions/RsvpChooser.tsx'].map(
    (p) => resolve(ROOT, p),
  ),
);

test.describe('Design-system density (#674, #1683)', () => {
  test('density tokens and modifiers are defined in index.css', () => {
    const css = READ(INDEX_CSS);
    for (const token of [
      '--cf-density-xs-card-padding',
      '--cf-density-compact-card-padding',
      '--cf-density-default-card-padding',
      '--cf-density-comfortable-card-padding',
      '--cf-density-xs-control-min-height',
      '--cf-density-compact-control-min-height',
      '--cf-density-default-control-min-height',
    ]) {
      expect(css, `${token} must exist`).toMatch(new RegExp(`${token}:`));
    }
    expect(css).toMatch(/\.cf-card\.cf-density-xs\s*\{/);
    expect(css).toMatch(/\.cf-card\.cf-density-compact\s*\{/);
    expect(css).toMatch(/\.cf-card\.cf-density-default\s*\{/);
    expect(css).toMatch(/\.cf-card\.cf-density-comfortable\s*\{/);
    expect(css).toMatch(/\.cf-btn\.cf-density-xs\s*\{/);
    expect(css).toMatch(/\.cf-btn\.cf-density-compact\s*\{/);
    expect(css).toMatch(/\.dialog\.cf-density-default\s*\{/);
    expect(css, 'Nocturne .card aliases compact density').toMatch(/^\.card\s*\{/m);
  });

  test('seg-opt (outside the ramp) pins its own 24px WCAG 2.2 SC 2.5.8 floor (#1693)', () => {
    const css = READ(NOCTURNE_CSS);
    const rule = /\.seg-opt\s*\{[^}]*\}/.exec(css);
    expect(rule, '.seg-opt rule must exist in nocturne.css').not.toBeNull();
    expect(rule![0], '.seg-opt must pin a literal 24px min-height floor').toMatch(
      /min-height:\s*24px/,
    );
  });

  /**
   * Issue #1683's non-negotiable floor: `xs` must never be a supported way to
   * ship a sub-24px pointer target (WCAG 2.2 SC 2.5.8, the same floor
   * `.cf-target-24` already codifies for issue #428). This parses the ACTUAL
   * declared value rather than just checking the token exists, so lowering it
   * — even to something that still "looks defined" — fails the build.
   */
  test('the xs control-min-height floor is at least 24px', () => {
    const css = READ(INDEX_CSS);
    const match = css.match(/--cf-density-xs-control-min-height:\s*([0-9.]+)px\s*;/);
    expect(match, '--cf-density-xs-control-min-height must be a literal px value').not.toBeNull();
    const px = Number(match![1]);
    expect(px, 'xs control-min-height must be >= 24px (WCAG 2.2 SC 2.5.8)').toBeGreaterThanOrEqual(24);
  });

  test('ui.tsx exports canonical primitives with density support', () => {
    const ui = READ(UI_TSX);
    const density = READ(DENSITY_TS);
    expect(density).toMatch(/export type UiDensity = 'xs' \| 'compact' \| 'default' \| 'comfortable'/);
    for (const name of ['Card', 'Btn', 'TextInput', 'TextArea', 'Chip', 'Dialog']) {
      expect(ui, `${name} must be exported`).toMatch(new RegExp(`export (function|const) ${name}\\b`));
    }
    expect(ui).toMatch(/density\?: UiDensity/);
    expect(ui).toMatch(/densityClass\(density\)/);
  });

  test('evidence sites from the issue use canonical components', () => {
    const home = READ(join(ROOT, 'features/home/HomePage.tsx'));
    expect(home).toMatch(/function CampaignTile[\s\S]*<Card[\s\S]*density="compact"/);
    expect(home).toMatch(/<Card key=\{c\.id\} density="compact" elev="sm"/);

    const ai = READ(join(ROOT, 'features/ai-dm/AiSetupChecklist.tsx'));
    expect(ai).toMatch(/<Card density="default">/);
    expect(ai).toMatch(/<Btn[^>]*density="compact"/);
    expect(ai).not.toMatch(/cf-card p-/);
    expect(ai).not.toMatch(/cf-btn[^"'\n]*!min-h-0/);
  });

  test('no source file carries retired geometry drift patterns', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file.endsWith('design-system-density.unit.spec.ts')) continue;
      const text = READ(file);
      for (const { name, pattern, why } of DRIFT_PATTERNS) {
        if (pattern.test(text)) {
          offenders.push(`${file.replace(ROOT + '/', '')}: ${name} (${why})`);
        }
      }
    }
    expect(offenders, `issue #674 drift:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * Issue #1683's named test: "no !important geometry override outside the
   * density API." Broader than the pre-existing `cf-btn`-scoped drift pattern
   * above — this fires on the retired idiom ANYWHERE in a className-ish
   * string, on any element, not only ones already carrying a cf-btn marker
   * class (that narrower scope is exactly what let 305 non-cf-btn-adjacent
   * sites accumulate before this issue). `HEIGHT_SHRINK_ALLOWED_FILES` is the
   * complete, reviewed exception list — see its own comment.
   */
  test('no !important height-shrink override outside the density API', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file.endsWith('design-system-density.unit.spec.ts')) continue;
      if (HEIGHT_SHRINK_ALLOWED_FILES.has(file)) continue;
      const text = READ(file);
      const matches = text.match(RETIRED_HEIGHT_SHRINK_RE);
      if (matches) {
        for (const m of matches) offenders.push(`${file.replace(ROOT + '/', '')}: ${m}`);
      }
    }
    expect(
      offenders,
      `issue #1683 drift — use density="xs" (or cf-density-xs on a raw element) instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
