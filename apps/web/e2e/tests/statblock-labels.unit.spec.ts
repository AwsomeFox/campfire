/**
 * Adapter-native statblock labels (issue #763).
 *
 * The shared StatBlock used to hardcode "Challenge" and "Armor Class" even when the
 * campaign's adapter mapped Level / Hit Dice / Guard into those slots. Presentation
 * metadata now lives on each RuleSystemAdapter; unknown/homebrew get neutral
 * Rating/Defense. Compendium (ReaderPage) and encounter (RunSessionPage) both render
 * via the same parseMonsterStatblock → StatBlock path, so label snapshots here are the
 * parity contract between those surfaces.
 */
import { expect, test } from '@playwright/test';
import {
  NEUTRAL_STATBLOCK_PRESENTATION,
  listRuleSystemAdapters,
  statblockPresentation,
} from '@campfire/schema';
import {
  parseMonsterStatblock,
  statblockVisibleLabels,
} from '../../src/components/StatBlock';

/** Minimal monster data that exercises rating + defense + HP + abilities + actions. */
const SAMPLE = {
  size: 'Medium',
  type: 'humanoid',
  level: 3,
  hitDice: '2+1',
  challengeRating: 2,
  armorClass: 14,
  ac: 15,
  hitPoints: 22,
  hp: 22,
  speed: 30,
  abilityScores: { strength: 12, dexterity: 14 },
  attributes: { agility: 2, might: 3 },
  defenses: { guard: 16 },
  actions: [{ name: 'Strike', desc: 'A basic attack.' }],
  traits: ['animal', 'humanoid'],
  descriptor: 'brutal warrior',
  role: 'spoiler',
};

test.describe('statblock labels (issue #763)', () => {
  test('snapshots presentation metadata for every registered adapter', () => {
    const snap = Object.fromEntries(
      listRuleSystemAdapters().map((adapter) => [adapter.id, adapter.presentation]),
    );
    // Playwright text snapshots (objects aren't supported by toMatchSnapshot directly).
    expect(JSON.stringify(snap, null, 2)).toMatchSnapshot('adapter-presentation.txt');
  });

  test('snapshots visible labels from parseMonsterStatblock for every adapter', () => {
    const snap = Object.fromEntries(
      listRuleSystemAdapters().map((adapter) => {
        const block = parseMonsterStatblock(SAMPLE, adapter.id);
        expect(block).not.toBeNull();
        return [adapter.id, statblockVisibleLabels(block!)];
      }),
    );
    expect(JSON.stringify(snap, null, 2)).toMatchSnapshot('parsed-visible-labels.txt');
  });

  test('native labels: Level, Hit Dice, Guard — not hardcoded Challenge / Armor Class', () => {
    const pf2e = parseMonsterStatblock(SAMPLE, 'pf2e');
    const osr = parseMonsterStatblock(SAMPLE, 'osr');
    const openLegend = parseMonsterStatblock(SAMPLE, 'open-legend');
    const dnd5e = parseMonsterStatblock(SAMPLE, 'dnd5e');

    expect(statblockVisibleLabels(pf2e!).ratingLine).toBe('Level 3');
    expect(statblockVisibleLabels(pf2e!).defense).toBe('Armor Class');
    expect(statblockVisibleLabels(osr!).ratingLine).toBe('Hit Dice 2+1');
    expect(statblockVisibleLabels(openLegend!).ratingLine).toBe('Level 3');
    expect(statblockVisibleLabels(openLegend!).defense).toBe('Guard');
    expect(statblockVisibleLabels(dnd5e!).ratingLine).toBe('Challenge 2');
    expect(statblockVisibleLabels(dnd5e!).defense).toBe('Armor Class');
  });

  test('unknown / homebrew resolve to neutral Rating / Defense', () => {
    expect(statblockPresentation(null)).toEqual(NEUTRAL_STATBLOCK_PRESENTATION);
    expect(statblockPresentation('my-homebrew')).toEqual(NEUTRAL_STATBLOCK_PRESENTATION);

    const homebrew = parseMonsterStatblock(SAMPLE, 'my-homebrew');
    const labels = statblockVisibleLabels(homebrew!);
    expect(labels.rating).toBe('Rating');
    expect(labels.defense).toBe('Defense');
    expect(labels.ratingLine).toBe('Rating 2');
  });

  test('compendium / encounter parity: both surfaces share parseMonsterStatblock labels', () => {
    // ReaderPage and RunSessionPage both call StatBlock with the campaign ruleSystem.
    // Parity = the same ruleSystem + dataJson yields identical visible labels regardless
    // of which surface asked (headingLevel is the only StatBlock prop that differs).
    for (const ruleSystem of listRuleSystemAdapters().map((a) => a.id)) {
      const compendium = parseMonsterStatblock(SAMPLE, ruleSystem);
      const encounter = parseMonsterStatblock(SAMPLE, ruleSystem);
      expect(statblockVisibleLabels(compendium!)).toEqual(statblockVisibleLabels(encounter!));
      expect(compendium!.presentation).toEqual(statblockPresentation(ruleSystem));
    }
  });

  test('full accessible terms are present; short abbreviations are optional extras', () => {
    for (const adapter of listRuleSystemAdapters()) {
      const p = adapter.presentation ?? NEUTRAL_STATBLOCK_PRESENTATION;
      for (const key of ['rating', 'defense', 'hitPoints', 'abilities', 'actions', 'creatureType'] as const) {
        expect(p[key].full.length).toBeGreaterThan(0);
        if (p[key].short !== undefined) {
          expect(p[key].short!.length).toBeGreaterThan(0);
          expect(p[key].short!.length).toBeLessThanOrEqual(p[key].full.length);
        }
      }
    }
  });
});
