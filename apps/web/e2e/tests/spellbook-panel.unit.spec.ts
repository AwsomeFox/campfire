import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  formatCastingTime,
  formatLevelName,
  filterSpells,
  groupSpellsByLevel,
  type SpellItem,
} from '../../src/features/encounters/SpellbookPanel';

const SPELLBOOK_PANEL_PATH = resolve(__dirname, '../../src/features/encounters/SpellbookPanel.tsx');
const TURN_WORKSPACE_PATH = resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx');

test.describe('In-combat Spellbook panel (issue #1851)', () => {
  test('SpellbookPanel.tsx contains all required UI affordances and contracts', () => {
    const src = readFileSync(SPELLBOOK_PANEL_PATH, 'utf8');

    // i18n check requirement
    expect(src).toContain('useTranslation');

    // Header stats: spellcasting attribute, attack mod, save DC
    expect(src).toContain('spellbook-stats-header');
    expect(src).toContain('spell-stat-attribute');
    expect(src).toContain('spell-stat-attack');
    expect(src).toContain('spell-stat-dc');

    // Pact magic slots row and pips
    expect(src).toContain('pact-magic-slots-row');
    expect(src).toContain('pact-slot-pips');

    // Search and filter input
    expect(src).toContain('spellbook-search-input');

    // Collapsible level sections and slot pips
    expect(src).toContain('spell-level-section-');
    expect(src).toContain('aria-expanded');
    expect(src).toContain('slot-pips-level-');

    // Per-spell row details & actions
    expect(src).toContain('cast-spell-');
    expect(src).toContain('upcast-spell-');
    expect(src).toContain('upcast-popover-');
    expect(src).toContain('concentration-indicator');
    expect(src).toContain('🔮 Conc');

    // Concentration warning modal
    expect(src).toContain('concentration-warning-modal');
    expect(src).toContain('confirm-concentration-replace');
    expect(src).toContain('cancel-concentration-replace');
  });

  test('TurnWorkspace.tsx integrates SpellbookPanel and exposes toggle button', () => {
    const src = readFileSync(TURN_WORKSPACE_PATH, 'utf8');

    expect(src).toContain('SpellbookPanel');
    expect(src).toContain('toggle-spellbook-btn');
    expect(src).toContain('encounters.turn.spellbook');
    expect(src).toContain('showSpellbook');
  });

  test('formatCastingTime converts verbose strings to standard abbreviations', () => {
    expect(formatCastingTime('1 Action')).toBe('1A');
    expect(formatCastingTime('action')).toBe('1A');
    expect(formatCastingTime('1 Bonus Action')).toBe('1BA');
    expect(formatCastingTime('bonus action')).toBe('1BA');
    expect(formatCastingTime('1 Reaction')).toBe('1R');
    expect(formatCastingTime('reaction')).toBe('1R');
    expect(formatCastingTime('10 Minutes')).toBe('10 Minutes');
  });

  test('formatLevelName formats levels accurately', () => {
    expect(formatLevelName(0)).toBe('Cantrips');
    expect(formatLevelName(1)).toBe('1st Level');
    expect(formatLevelName(2)).toBe('2nd Level');
    expect(formatLevelName(3)).toBe('3rd Level');
    expect(formatLevelName(4)).toBe('4th Level');
  });

  test('filterSpells filters by name, school, or casting time', () => {
    const sampleSpells: SpellItem[] = [
      { id: '1', name: 'Fireball', level: 3, school: 'Evocation', castingTime: '1 Action', range: '150 ft' },
      { id: '2', name: 'Shield', level: 1, school: 'Abjuration', castingTime: '1 Reaction', range: 'Self' },
      { id: '3', name: 'Healing Word', level: 1, school: 'Evocation', castingTime: '1 Bonus Action', range: '60 ft' },
    ];

    expect(filterSpells(sampleSpells, 'fire')).toHaveLength(1);
    expect(filterSpells(sampleSpells, 'fire')[0].name).toBe('Fireball');

    expect(filterSpells(sampleSpells, 'Abjuration')).toHaveLength(1);
    expect(filterSpells(sampleSpells, 'Abjuration')[0].name).toBe('Shield');

    expect(filterSpells(sampleSpells, '1BA')).toHaveLength(1);
    expect(filterSpells(sampleSpells, '1BA')[0].name).toBe('Healing Word');

    expect(filterSpells(sampleSpells, '')).toHaveLength(3);
  });

  test('groupSpellsByLevel groups spells by level accurately', () => {
    const sampleSpells: SpellItem[] = [
      { id: '1', name: 'Fire Bolt', level: 0, castingTime: '1A', range: '120 ft' },
      { id: '2', name: 'Magic Missile', level: 1, castingTime: '1A', range: '120 ft' },
      { id: '3', name: 'Shield', level: 1, castingTime: '1R', range: 'Self' },
      { id: '4', name: 'Misty Step', level: 2, castingTime: '1BA', range: 'Self' },
    ];

    const grouped = groupSpellsByLevel(sampleSpells);
    expect(grouped.get(0)).toHaveLength(1);
    expect(grouped.get(1)).toHaveLength(2);
    expect(grouped.get(2)).toHaveLength(1);
    expect(grouped.get(3)).toBeUndefined();
  });
});
