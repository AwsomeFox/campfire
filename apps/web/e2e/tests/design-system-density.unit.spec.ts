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
  {
    name: 'legacy .btn geometry override',
    // Ported from #1697/issue #1695 (ported rather than merged separately — see PR
    // description) — ties directly into #1683's own retirement of !min-h-0/!py-* on
    // .btn: this codebase now expresses the sub-default floor through the xs density
    // step (`cf-density-xs`/`density="xs"`, `.btn.cf-density-xs` at 0,0,2,0
    // specificity) rather than a hand-pinned `!min-h-[24px]`. Deliberately excludes
    // cf-btn (handled by the pattern above) via the negative lookbehind — `.btn` is
    // the pre-cf-btn Nocturne class, which index.css aliases to the ramp's default
    // 44px control height ("Nocturne .btn aliases default-density controls (issue
    // #674)"). `!min-h-0` zeroes that alias out via Tailwind's !important, same
    // failure mode as cf-btn, just on a plain (not cf-) button class.
    pattern: /(?<!cf-)\bbtn\b[^"'`\n]*!min-h-0/,
    why: 'use <Btn density="xs"> / add cf-density-xs instead of !min-h-0 on .btn — ' +
      '.btn aliases to the ramp default and !min-h-0 zeroes that out entirely (issue #1695)',
  },
  {
    name: 'inline minHeight:0 override on a .btn/cf-btn control',
    // The four patterns above only see the retired idiom when it is spelled as a
    // Tailwind class (!min-h-0) inside a className string. The IDENTICAL override
    // survives completely invisible to all of them when spelled as an inline style
    // instead — found live in CharacterPage.tsx during this PR's own review (a
    // `<button className="btn btn-ghost" style={{ ..., minHeight: 0, ... }}>`,
    // exactly the shape 'legacy .btn geometry override' above exists to ban, just
    // in a form the regex could not see). A guard that only covers the className
    // form is worse than no guard — it reports clean while the banned idiom
    // persists. Matches className/style in either JSX attribute order.
    pattern:
      /<[a-zA-Z][^>]*\bclassName="[^"]*\b(?:btn|cf-btn)\b[^"]*"[^>]*\bstyle=\{\{[^}]*\bminHeight:\s*0\b[^}]*\}\}[^>]*>|<[a-zA-Z][^>]*\bstyle=\{\{[^}]*\bminHeight:\s*0\b[^}]*\}\}[^>]*\bclassName="[^"]*\b(?:btn|cf-btn)\b[^"]*"[^>]*>/,
    why: 'the !min-h-0 idiom expressed as an inline style instead of a Tailwind class — ' +
      'invisible to the className-scoped patterns above. Use <Btn density="xs"> or drop the ' +
      'inline minHeight override; do not zero a .btn/cf-btn control\'s height via inline style',
  },
];

/**
 * Pre-existing, already-reported instances of the pattern just above (issue #1683
 * review) — every one this new pattern found repo-wide, not just the one site the
 * review named. Each measured via getComputedStyle (apps/web/e2e/lib/
 * computedStyle.ts) against the real compiled CSS, not inferred from source:
 *
 *   - CharacterPage.tsx "+ add" condition button (btn btn-ghost, fontSize 12,
 *     padding '4px 10px'): 24.39px. NOT under the 24px WCAG 2.2 SC 2.5.8 floor —
 *     clears it by 0.39px of coincidental padding/line-height math, the same
 *     "clears without enforcing" shape already documented for .cf-target-24 + .btn
 *     elsewhere in this file.
 *   - RegionMap.tsx, all 4 sites (btn-ghost x3 + bare btn x1, all fontSize 11,
 *     padding '2px 8px'): 19.19px. LIVE VIOLATION — under the 24px floor.
 *   - RunSessionPage.tsx's map-derivatives retry button (btn btn-ghost, fontSize 11,
 *     padding '2px 8px' — identical shape to RegionMap's): 19.19px. LIVE VIOLATION.
 *   - DiceTray.tsx (cf-btn cf-btn-ghost, fontSize 12.5, padding '4px 12px'):
 *     29.38px. Not a violation.
 *   - CampaignSettingsPage.tsx, both sites (btn-secondary + btn-ghost, fontSize
 *     12.5, padding '4px 12px'): 25px each. Not a violation, but only by 1px.
 *
 * None of these are fixed in this PR — #1692's job is the density API, not an a11y
 * sweep, and the two live violations especially need their own tracked fix, not a
 * drive-by inside an unrelated PR. Filed as issue #1722, with these measurements,
 * the near-misses, and an explicit warning not to "fix" any of them by just
 * deleting the inline `minHeight: 0` — on a bare `.btn` that snaps to the ramp's
 * 44px default and would visibly wreck a dense map toolbar.
 *
 * Retired against issue #1722 — all 5 pre-existing sites migrated to canonical
 * density="xs" / cf-density-xs control sizing.
 */
const INLINE_MIN_HEIGHT_ZERO_ALLOWED: ReadonlyMap<string, number> = new Map([]);

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
 *
 * Keyed by the EXACT matched string, not the file (issue #1692 review, Codex):
 * a whole-file skip would also hide any NEW, unreviewed violation introduced
 * anywhere else in one of these four files — as it currently does for
 * OidcCard.tsx and StorageCard.tsx, which carry other shared buttons besides
 * their one reviewed decorative exception. Any match in one of these files
 * that ISN'T exactly one of the strings below still fails the test.
 * Any NEW allowance must add its own exact string here, with a reason (or the
 * site should get a real `xs`/`compact` density instead) — this allowlist
 * must not grow silently.
 */
const HEIGHT_SHRINK_ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [resolve(ROOT, 'features/admin/OidcCard.tsx'), new Set(['className="cf-chip cf-chip-private !py-0 !text-[9px]"'])],
  [resolve(ROOT, 'features/admin/StorageCard.tsx'), new Set(['className="cf-chip cf-chip-failed ml-2 !py-0 !text-[9px]"'])],
  [
    resolve(ROOT, 'features/characters/CharacterSheetNav.tsx'),
    new Set(['className="tag tag-accent text-[9px] !py-0 !px-1.5"']),
  ],
  [
    resolve(ROOT, 'features/sessions/RsvpChooser.tsx'),
    new Set(['className="seg-opt cf-schedule-rsvp-opt !py-1 !px-2.5 text-xs"']),
  ],
]);

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

  /**
   * WCAG 2.2 SC 2.5.8 is a 24×24 minimum, both axes (issue #1692 review, Codex) —
   * the test above only pinned height. A glyph-only xs control with reduced
   * horizontal padding (e.g. RunSessionPage's Resolve Point −/+ buttons,
   * `!px-1 text-[10px] cf-density-xs`) can clear the height floor while its
   * width stays well under 24px. Same treatment as the height token: parse the
   * actual declared value, and confirm both `.cf-btn.cf-density-xs` and
   * `.btn.cf-density-xs` actually apply it (a token existing in :root proves
   * nothing about whether any rule consumes it).
   */
  test('the xs control-min-width floor is at least 24px and is applied by both .cf-btn and .btn', () => {
    const css = READ(INDEX_CSS);
    const match = css.match(/--cf-density-xs-control-min-width:\s*([0-9.]+)px\s*;/);
    expect(match, '--cf-density-xs-control-min-width must be a literal px value').not.toBeNull();
    const px = Number(match![1]);
    expect(px, 'xs control-min-width must be >= 24px (WCAG 2.2 SC 2.5.8)').toBeGreaterThanOrEqual(24);

    const cfBtnRule = /\.cf-btn\.cf-density-xs\s*\{[^}]*\}/.exec(css);
    expect(cfBtnRule, '.cf-btn.cf-density-xs rule must exist').not.toBeNull();
    expect(cfBtnRule![0], '.cf-btn.cf-density-xs must set min-width').toMatch(
      /min-width:\s*var\(--cf-density-xs-control-min-width\)/,
    );

    const btnRule = /\.btn\.cf-density-xs,\s*\n\s*\.btn\.btn-density-xs\s*\{[^}]*\}/.exec(css);
    expect(btnRule, '.btn.cf-density-xs rule must exist').not.toBeNull();
    expect(btnRule![0], '.btn.cf-density-xs must set min-width').toMatch(
      /min-width:\s*var\(--cf-density-xs-control-min-width\)/,
    );
  });

  /**
   * Issue #1698: `.cf-target-24` and `.cf-target-44` target-size helpers must not be silently
   * overridden by `.btn` density aliases or `.btn.cf-density-*` rules at equal or lower specificity.
   * Target helpers must be declared after control base classes (.btn, .cf-btn, .input) and provide
   * compound selectors (.btn.cf-target-*, .cf-btn.cf-target-*, .input.cf-target-*) so explicit target
   * sizes take precedence over default control min-heights.
   */
  test('.cf-target-24 and .cf-target-44 floors cannot be silently overridden by control aliases (issue #1698)', () => {
    const css = READ(INDEX_CSS);

    // Rule position check: target helpers must be declared after .btn alias in index.css
    const btnPos = css.indexOf('.btn {');
    const target24Pos = css.lastIndexOf('.cf-target-24');
    const target44Pos = css.lastIndexOf('.cf-target-44');
    expect(btnPos, '.btn rule must exist').toBeGreaterThan(-1);
    expect(target24Pos, '.cf-target-24 must be declared after .btn').toBeGreaterThan(btnPos);
    expect(target44Pos, '.cf-target-44 must be declared after .btn').toBeGreaterThan(btnPos);

    // Specificity / compound selector checks
    expect(css, '.btn.cf-target-24 compound rule must exist').toMatch(/\.btn\.cf-target-24\b/);
    expect(css, '.btn.cf-target-44 compound rule must exist').toMatch(/\.btn\.cf-target-44\b/);
    expect(css, '.cf-btn.cf-target-24 compound rule must exist').toMatch(/\.cf-btn\.cf-target-24\b/);
    expect(css, '.cf-btn.cf-target-44 compound rule must exist').toMatch(/\.cf-btn\.cf-target-44\b/);
    expect(css, '.input.cf-target-24 compound rule must exist').toMatch(/\.input\.cf-target-24\b/);
    expect(css, '.input.cf-target-44 compound rule must exist').toMatch(/\.input\.cf-target-44\b/);
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

  test('sites from issue #1722 use density="xs" or cf-density-xs instead of inline minHeight: 0', () => {
    const regionMap = READ(join(ROOT, 'features/dashboard/RegionMap.tsx'));
    expect(regionMap).toMatch(/btn btn-ghost cf-density-xs/);
    expect(regionMap).not.toMatch(/style=\{\{[^}]*minHeight:\s*0/);

    const runSession = READ(join(ROOT, 'features/encounters/RunSessionPage.tsx'));
    expect(runSession).toMatch(/btn btn-ghost cf-density-xs/);

    const charPage = READ(join(ROOT, 'features/characters/CharacterPage.tsx'));
    expect(charPage).toMatch(/density="xs"/);
    expect(charPage).toMatch(/btn btn-ghost cf-density-xs/);
    expect(charPage).not.toMatch(/style=\{\{[^}]*minHeight:\s*0/);

    const campaignSettings = READ(join(ROOT, 'features/settings/CampaignSettingsPage.tsx'));
    expect(campaignSettings).toMatch(/btn btn-secondary cf-density-xs/);
    expect(campaignSettings).toMatch(/btn btn-ghost cf-density-xs/);
    expect(campaignSettings).not.toMatch(/style=\{\{[^}]*minHeight:\s*0/);

    const diceTray = READ(join(ROOT, 'features/dice/DiceTray.tsx'));
    expect(diceTray).toMatch(/<Btn[^>]*density="xs"/);
  });

  test('no source file carries retired geometry drift patterns', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file.endsWith('design-system-density.unit.spec.ts')) continue;
      const text = READ(file);
      for (const { name, pattern, why } of DRIFT_PATTERNS) {
        if (name === 'inline minHeight:0 override on a .btn/cf-btn control') {
          const globalPattern = new RegExp(pattern.source, 'g');
          const matches = text.match(globalPattern);
          const count = matches ? matches.length : 0;
          const allowed = INLINE_MIN_HEIGHT_ZERO_ALLOWED.get(file) ?? 0;
          if (count > allowed) {
            offenders.push(`${file.replace(ROOT + '/', '')}: ${name} (${count} found, max allowed ${allowed}) (${why})`);
          }
          continue;
        }
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
   * sites accumulate before this issue). `HEIGHT_SHRINK_ALLOWED` is the
   * complete, reviewed exception list, keyed by exact match — see its own
   * comment for why a whole-file skip was wrong here.
   */
  test('no !important height-shrink override outside the density API', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file.endsWith('design-system-density.unit.spec.ts')) continue;
      const allowedForFile = HEIGHT_SHRINK_ALLOWED.get(file);
      const text = READ(file);
      const matches = text.match(RETIRED_HEIGHT_SHRINK_RE);
      if (matches) {
        for (const m of matches) {
          if (allowedForFile?.has(m)) continue;
          offenders.push(`${file.replace(ROOT + '/', '')}: ${m}`);
        }
      }
    }
    expect(
      offenders,
      `issue #1683 drift — use density="xs" (or cf-density-xs on a raw element) instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
