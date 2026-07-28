/**
 * Design-system density consolidation (issue #674).
 *
 * Nocturne (.card/.btn/.input) and cf-* once drifted on radii, padding, and
 * elevation. The canonical ramp lives in index.css + ui.tsx primitives with
 * compact/default/comfortable density. This suite pins the invariants so a
 * one-line Tailwind override cannot reintroduce competing geometry.
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
    // Matches className/class strings that contain both `btn` and `!min-h-0`
    // regardless of class token ordering, excluding `cf-btn` (issue #1695).
    pattern: /\bclass(?:Name)?=["'`][^"'`\n]*(?=\bbtn\b)[^"'`\n]*!min-h-0|\bclass(?:Name)?=["'`][^"'`\n]*!min-h-0[^"'`\n]*(?=\bbtn\b)/,
    why: 'use !min-h-[24px] (WCAG 2.2 SC 2.5.8 floor) instead of !min-h-0 on .btn — ' +
      '.btn aliases to the ramp default and !min-h-0 zeroes that out entirely (issue #1695)',
  },
];

test.describe('Design-system density (#674)', () => {
  test('density tokens and modifiers are defined in index.css', () => {
    const css = READ(INDEX_CSS);
    for (const token of [
      '--cf-density-compact-card-padding',
      '--cf-density-default-card-padding',
      '--cf-density-comfortable-card-padding',
      '--cf-density-compact-control-min-height',
      '--cf-density-default-control-min-height',
    ]) {
      expect(css, `${token} must exist`).toMatch(new RegExp(`${token}:`));
    }
    expect(css).toMatch(/\.cf-card\.cf-density-compact\s*\{/);
    expect(css).toMatch(/\.cf-card\.cf-density-default\s*\{/);
    expect(css).toMatch(/\.cf-card\.cf-density-comfortable\s*\{/);
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

  test('ui.tsx exports canonical primitives with density support', () => {
    const ui = READ(UI_TSX);
    const density = READ(DENSITY_TS);
    expect(density).toMatch(/export type UiDensity = 'compact' \| 'default' \| 'comfortable'/);
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
});
