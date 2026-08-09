import { expect, test } from '@playwright/test';
import {
  Archmage13aAdapter,
  BasicFantasyAdapter,
  Dnd5eAdapter,
  OSR_VARIANT_ADAPTERS,
  OpenLegendAdapter,
  StarforgedAdapter,
  listRuleSystemAdapters,
  checkCatalogForAdapter,
  hasInitiativeRollForAdapter,
  hasNeutralD20ChecksForAdapter,
} from '@campfire/schema';
import { ROLL_MODES, rollModeOptions, rollModeSummary, resolveRollMode, rollModeForClick, type RollMode } from '../../src/features/characters/rollMode';

/**
 * Issue #713 — touch + keyboard roll-mode chooser.
 *
 * The chooser component (`RollModeChooser.tsx`) is thin render + a11y wiring;
 * its only logic is the pure functions in `rollMode.ts` exercised here. These
 * tests pin the three-mode vocabulary, the per-mode summary shown before
 * submission, and the rule that a modifier-key click is a ONE-SHOT override of
 * the persistent chooser selection (so the desktop shortcut coexists with the
 * touch chooser instead of clobbering it).
 */

test.describe('roll-mode vocabulary (issue #713)', () => {
  test('exposes exactly Flat / Advantage / Disadvantage, in that order', () => {
    expect(ROLL_MODES).toEqual(['normal', 'advantage', 'disadvantage']);
    const opts = rollModeOptions();
    expect(opts.map((o) => o.mode)).toEqual(['normal', 'advantage', 'disadvantage']);
    expect(opts.map((o) => o.label)).toEqual(['Normal', 'Advantage', 'Disadvantage']);
  });

  test('every option has a descriptive accessible name (not just the short label)', () => {
    for (const opt of rollModeOptions()) {
      // The accessible name must convey the effect, so a screen-reader user
      // picks "roll two d20 and keep the higher" over "Flat" unambiguously.
      expect(opt.description.length).toBeGreaterThan(opt.label.length);
      expect(opt.description.toLowerCase()).toContain('d20');
    }
  });
});

test.describe('roll-mode summary shown before submission (issue #713)', () => {
  const cases: Array<[RollMode, RegExp]> = [
    ['normal', /^normal roll$/i],
    ['advantage', /advantage/i],
    ['disadvantage', /disadvantage/i],
  ];
  for (const [mode, re] of cases) {
    test(`${mode} announces the active mode`, () => {
      expect(rollModeSummary(mode)).toMatch(re);
    });
  }
});

test.describe('modifier-key shortcut coexists with the chooser (issue #713)', () => {
  const noMods = { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };

  test('a plain tap rolls the chosen persistent mode', () => {
    expect(resolveRollMode('normal', noMods)).toBe('normal');
    expect(resolveRollMode('advantage', noMods)).toBe('advantage');
    expect(resolveRollMode('disadvantage', noMods)).toBe('disadvantage');
  });

  test('shift-click overrides ANY chosen mode with advantage for this roll only', () => {
    for (const chosen of ROLL_MODES) {
      expect(resolveRollMode(chosen, { ...noMods, shiftKey: true })).toBe('advantage');
    }
  });

  test('alt/ctrl/meta-click overrides ANY chosen mode with disadvantage for this roll only', () => {
    for (const chosen of ROLL_MODES) {
      expect(resolveRollMode(chosen, { ...noMods, altKey: true })).toBe('disadvantage');
      expect(resolveRollMode(chosen, { ...noMods, ctrlKey: true })).toBe('disadvantage');
      expect(resolveRollMode(chosen, { ...noMods, metaKey: true })).toBe('disadvantage');
    }
  });

  test('shift wins over alt/ctrl/meta (advantage takes precedence, matching advFromEvent)', () => {
    expect(
      resolveRollMode('normal', { shiftKey: true, altKey: true, ctrlKey: true, metaKey: true }),
    ).toBe('advantage');
  });

  test('the override does not mutate the chosen default — a following plain tap reverts', () => {
    // resolveRollMode is pure: it returns the EFFECTIVE mode for one roll, never
    // signals a state change. The chooser keeps its selection; the next no-mod
    // tap rolls the chosen mode again. (The component holds the state, not this fn.)
    const chosen: RollMode = 'disadvantage';
    resolveRollMode(chosen, { ...noMods, shiftKey: true });
    expect(resolveRollMode(chosen, noMods)).toBe('disadvantage');
  });
});

/**
 * Codex review on #2115 — the chooser was decorative on the Saving throws and Actions
 * cards. `RollContextMenu` folds shift/alt-click and its long-press menu into ONE mode and
 * emits 'normal' for a plain click, so call sites that fed that value back in as the
 * "chosen" default could never see the chooser's selection: a touch user who picked
 * Advantage and tapped the attack still submitted a flat d20 — precisely the gap this
 * issue added the chooser to close.
 */
test.describe('rollModeForClick — the chooser is the default, one click can override it', () => {
  // RollContextMenu passes the MouseEvent on the plain-click path and nothing from its
  // menu. A bare object stands in for that event here; only its presence is read.
  const plainClick = {};

  test('a plain click rolls whatever the chooser has selected', () => {
    for (const chosen of ROLL_MODES) {
      expect(rollModeForClick('normal', chosen, plainClick)).toBe(chosen);
    }
  });

  test('an explicit click mode wins over the chooser for that roll', () => {
    expect(rollModeForClick('advantage', 'disadvantage', plainClick)).toBe('advantage');
    expect(rollModeForClick('disadvantage', 'advantage', plainClick)).toBe('disadvantage');
    // The long-press / context menu can also ask for a crit; it is an override like any other.
    expect(rollModeForClick('crit', 'advantage')).toBe('crit');
  });

  /**
   * Both a plain tap and the menu's own "Normal" item emit 'normal'. Only the tap means
   * "no preference"; the menu item is an explicit request for a flat roll, and treating it
   * as no-preference made that command do nothing whenever a mode was chosen.
   */
  test('an explicit Normal from the menu beats the chooser; a plain tap does not', () => {
    for (const chosen of ROLL_MODES) {
      expect(rollModeForClick('normal', chosen)).toBe('normal');
    }
    expect(rollModeForClick('normal', 'advantage', plainClick)).toBe('advantage');
    expect(rollModeForClick('normal', 'disadvantage', plainClick)).toBe('disadvantage');
  });

  test('it is pure — overriding once leaves the chooser selection intact', () => {
    const chosen: RollMode = 'advantage';
    rollModeForClick('disadvantage', chosen, plainClick);
    expect(rollModeForClick('normal', chosen, plainClick)).toBe('advantage');
  });
});

/**
 * Codex review on #2115 — a system can have no initiative roll at all. `initiativeDie`
 * cannot express that (the generic roller seam requires a die from every adapter, so
 * Starforged reports its d6 action die), and "not group" is not the same as "individual".
 */
test.describe('hasInitiativeRollForAdapter — omission means yes, opting out is explicit', () => {
  test('an adapter that says nothing keeps an initiative roll', () => {
    expect(hasInitiativeRollForAdapter(Dnd5eAdapter)).toBe(true);
    expect(hasInitiativeRollForAdapter({})).toBe(true);
    expect(hasInitiativeRollForAdapter(null)).toBe(true);
    expect(hasInitiativeRollForAdapter(undefined)).toBe(true);
  });

  test('Starforged has none, and still reports a die for the roller seam', () => {
    expect(hasInitiativeRollForAdapter(StarforgedAdapter)).toBe(false);
    // The die is a seam artifact, which is exactly why reading it cannot answer the question.
    expect(StarforgedAdapter.initiativeDie).toBe(6);
  });
});

/**
 * Codex review on #2115 — these capabilities have to be enforced in the SHARED catalog, not
 * at a render site. `checkCatalogForAdapter` is the one seam the character sheet, the
 * encounter card, REST `/checks` + `/checks/roll`, and the MCP `list_checks`/`roll_check`
 * tools all read; gating only the sheet left every other caller able to discover and persist
 * a roll the adapter says does not exist.
 */
test.describe('checkCatalogForAdapter — offers nothing a system cannot actually roll', () => {
  const character = {
    level: 3,
    stats: { STR: 12, DEX: 14, EDGE: 2, IRON: 3 },
    saveProficiencies: [],
    skills: {},
  };

  test('5e is unaffected — it keeps initiative and its d20 checks', () => {
    const catalog = checkCatalogForAdapter(Dnd5eAdapter, character);
    expect(catalog.some((c) => c.category === 'initiative')).toBe(true);
    expect(catalog.some((c) => c.category === 'ability')).toBe(true);
    expect(hasNeutralD20ChecksForAdapter(Dnd5eAdapter)).toBe(true);
  });

  test('Starforged contributes no checks at all — no d20 checks, and no initiative roll', () => {
    expect(hasNeutralD20ChecksForAdapter(StarforgedAdapter)).toBe(false);
    expect(checkCatalogForAdapter(StarforgedAdapter, character)).toEqual([]);
  });

  test('Open Legend contributes no checks — its attribute roll is an exploding pool', () => {
    expect(hasNeutralD20ChecksForAdapter(OpenLegendAdapter)).toBe(false);
    const catalog = checkCatalogForAdapter(OpenLegendAdapter, character);
    expect(catalog.some((c) => c.category === 'ability')).toBe(false);
    expect(catalog.some((c) => c.category === 'save')).toBe(false);
    // It DOES roll initiative (Agility-monotonic), so that entry legitimately survives.
    expect(catalog.some((c) => c.category === 'initiative')).toBe(true);
  });

  test('omission still means yes for both capabilities', () => {
    expect(hasNeutralD20ChecksForAdapter({})).toBe(true);
    expect(hasNeutralD20ChecksForAdapter(null)).toBe(true);
    expect(hasInitiativeRollForAdapter({})).toBe(true);
  });
});

/**
 * Codex review on #2115 — the neutral catalog computed initiative through
 * `initiativeModifier` but published `ability: null`, so a caller gating on "is the source
 * score actually set" (the sheet does, so a draft cannot roll a fabricated +0) had nothing
 * to gate on. Adapters that read an ability now declare it.
 */
test.describe('neutral initiative declares the score it reads', () => {
  const character = { level: 3, stats: { DEX: 14, AGILITY: 5 }, saveProficiencies: [], skills: {} };
  const initiativeOf = (adapter: Parameters<typeof checkCatalogForAdapter>[0]) =>
    checkCatalogForAdapter(adapter, character).find((c) => c.category === 'initiative') ?? null;

  test('13th Age names DEX', () => {
    expect(initiativeOf(Archmage13aAdapter)?.ability).toBe('DEX');
  });

  test('Open Legend names AGILITY', () => {
    expect(initiativeOf(OpenLegendAdapter)?.ability).toBe('AGILITY');
  });

  test('an OSR variant that adds the DEX modifier names it; one that does not stays ability-less', () => {
    expect(BasicFantasyAdapter.initiativeModel?.usesDexModifier).toBe(true);
    expect(initiativeOf(BasicFantasyAdapter)?.ability).toBe('DEX');
    const bareD6 = OSR_VARIANT_ADAPTERS['swords-wizardry'];
    expect(bareD6.initiativeModel?.usesDexModifier).toBe(false);
    expect(bareD6.initiativeAbility).toBeUndefined();
  });

  test('5e already published its own — unchanged', () => {
    expect(initiativeOf(Dnd5eAdapter)?.ability).toBe('DEX');
  });

  /**
   * Registry-wide, because declaring this adapter-by-adapter is exactly how it drifted:
   * the first pass covered 13th Age, Open Legend and the OSR variants and missed Starfinder
   * AND Pathfinder 1e, both DEX-derived. Probing `initiativeModifier` for a reaction to a
   * score is what the declaration is supposed to mirror, so assert they agree for EVERY
   * neutral-catalog adapter rather than listing the ones we remembered.
   */
  test('every neutral-catalog adapter declares an initiative ability iff its modifier reads one', () => {
    const probes = { DEX: 18, AGILITY: 8, AGI: 8, WIS: 18, CHA: 18, INT: 18, STR: 18 };
    const mismatches: string[] = [];
    for (const adapter of listRuleSystemAdapters()) {
      // Adapters with their own catalog publish the ability directly and ignore the field.
      if (typeof adapter.buildCheckCatalog === 'function') continue;
      const baseline = adapter.initiativeModifier({}, 'score', 3);
      const readsAnAbility = Object.entries(probes).some(
        ([key, value]) => adapter.initiativeModifier({ [key]: value }, 'score', 3) !== baseline,
      );
      const declares = adapter.initiativeAbility != null;
      if (readsAnAbility !== declares) {
        mismatches.push(`${adapter.id}: reads=${readsAnAbility} declares=${adapter.initiativeAbility ?? 'none'}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
