import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  ruleSystemAdapter,
  checkCatalogForAdapter,
  sortCheckCatalog,
  filterCheckCatalog,
  type CheckCatalogCharacter,
} from '@campfire/schema';

/**
 * Issue #2154 — the character sheet's Skills card has a search box, mirroring the
 * encounter card's (`CharacterStatCard`) skill search: the same shared
 * `filterCheckCatalog`, the same `data-testid="check-search"`, so a long skill list
 * narrows as the user types.
 *
 * The sheet's `SkillsCard` (a private function in `CharacterPage.tsx`) previously
 * rendered every skill in the adapter's catalog unconditionally — no search, no filter.
 * These tests guard the wiring (source-scan, in the established character-sheet
 * unit-spec convention used by `character-print-controls.unit.spec.ts`) AND the filter
 * behavior itself on the real 5e catalog the card renders (the exact pipeline
 * `SkillsCard` builds: `checkCatalogForAdapter` → `sortCheckCatalog` → skill filter →
 * `filterCheckCatalog`).
 */

const characterPagePath = resolve(__dirname, '../../src/features/characters/CharacterPage.tsx');

test.describe('SkillsCard search wiring (#2154)', () => {
  // Slice out just the SkillsCard function so the assertions can't be satisfied by the
  // encounter card's identical pattern elsewhere in the same file. The start/end markers
  // are validated explicitly below: if either ever moves or is renamed, the slice collapses
  // to '' (so the wiring assertions fail loudly) instead of silently swallowing the rest of
  // the file via `slice(start, -1)` — the exact weakening the #2154 review flagged.
  const code = readFileSync(characterPagePath, 'utf8');
  const startIndex = code.indexOf('function SkillsCard(');
  const endIndex = code.indexOf('function WeaponTrainingCard(');
  const skillsCard = startIndex >= 0 && endIndex > startIndex ? code.slice(startIndex, endIndex) : '';

  test('locates the SkillsCard source slice (markers found and ordered)', () => {
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
  });

  test('renders a check-search input with the encounter-card parity attributes', () => {
    expect(skillsCard).toContain('data-testid="check-search"');
    expect(skillsCard).toContain('type="search"');
    expect(skillsCard).toContain('placeholder="Search skills…"');
  });

  test('filters through the shared filterCheckCatalog, not a reimplementation', () => {
    expect(skillsCard).toContain('filterCheckCatalog');
  });

  test('renders the filtered list (skills.map), not the unconditional catalog', () => {
    expect(skillsCard).toMatch(/skills\.map\(/);
    // The old unconditional render must be gone — if it returns, the search box narrows
    // a list the user never sees.
    expect(skillsCard).not.toMatch(/skillChecks\.map\(/);
  });

  test('shows an empty-state message for a non-matching query (parity with CharacterStatCard)', () => {
    expect(skillsCard).toContain('No skills match');
  });
});

test.describe('filterCheckCatalog narrows a long skill list as you type (#2154)', () => {
  // The exact catalog `SkillsCard` builds for a 5e character: every skill, proficient
  // or not, favorites first (sortCheckCatalog). A blank 10s-across level-1 sheet so the
  // catalog is the full unproficient baseline.
  const adapter = ruleSystemAdapter('dnd5e');
  const character: CheckCatalogCharacter = {
    level: 1,
    stats: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
    saveProficiencies: [],
    skills: {},
  };
  const allSkills = sortCheckCatalog(checkCatalogForAdapter(adapter, character)).filter(
    (c) => c.category === 'skill',
  );

  test('the full 5e skill list is long enough that finding one is the problem this solves', () => {
    // The 5e SRD's 18 skills are the motivating case for a search box.
    expect(allSkills.length).toBe(18);
  });

  test('an empty query leaves the whole list visible (the no-op filter)', () => {
    expect(filterCheckCatalog(allSkills, '')).toHaveLength(allSkills.length);
  });

  test('typing a label fragment narrows to label matches', () => {
    expect(filterCheckCatalog(allSkills, 'ath').map((s) => s.label)).toEqual(['Athletics']);
  });

  test('the filter is case-insensitive', () => {
    expect(filterCheckCatalog(allSkills, 'STEALTH').map((s) => s.label)).toEqual(['Stealth']);
  });

  test('a query matching the governing ability also surfaces skills (e.g. "wis")', () => {
    const wisdom = filterCheckCatalog(allSkills, 'wis');
    expect(wisdom.length).toBeGreaterThan(0);
    // Every result is governed by WIS — the ability-key branch of the filter, not label luck.
    for (const s of wisdom) expect(s.ability).toBe('WIS');
  });

  test('a query that matches nothing yields an empty list (the empty-state case)', () => {
    expect(filterCheckCatalog(allSkills, 'zzzzz')).toEqual([]);
  });
});
