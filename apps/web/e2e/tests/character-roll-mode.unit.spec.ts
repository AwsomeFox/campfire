import { expect, test } from '@playwright/test';
import {
  Archmage13aAdapter,
  BasicFantasyAdapter,
  Dnd5eAdapter,
  OSR_VARIANT_ADAPTERS,
  OpenLegendAdapter,
  Pathfinder1eAdapter,
  Pf2eAdapter,
  StarforgedAdapter,
  listRuleSystemAdapters,
  checkCatalogForAdapter,
  hasAdapterOwnedAttackRoll,
  hasCriticalHitsForAdapter,
  hasInitiativeRollForAdapter,
  hasNeutralD20ChecksForAdapter,
} from '@campfire/schema';
import {
  ROLL_MODES,
  rollModeOptions,
  rollModeSummary,
  resolveRollMode,
  rollModeForClick,
  showsInitiativeTile,
  allowsCriticalDamageRoll,
  type RollMode,
} from '../../src/features/characters/rollMode';

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
   * The two cases a consumer must not confuse — and which a total-based test DOES confuse,
   * which is how an earlier fix here reintroduced the bug it was meant to close.
   */
  test('a level term does not disguise a missing ability score', () => {
    // 13th Age adds `levelInitiativeBonus`, so a level-3 character with no DEX totals +3
    // from the level alone. The ability contributed nothing, so this is incomplete.
    const noDex = { level: 3, stats: { STR: 12 }, saveProficiencies: [], skills: {} };
    const def = initiativeOf(Archmage13aAdapter);
    expect(def?.ability).toBe('DEX');
    const incomplete = checkCatalogForAdapter(Archmage13aAdapter, noDex).find((c) => c.category === 'initiative');
    expect(incomplete?.modifier).not.toBe(0);
    expect(incomplete?.incomplete).toBe(true);
  });

  /**
   * The test rules ON the ability-derived component, not on ability PRESENCE — so a system
   * whose modifier came from somewhere else is not called incomplete. Documented against a
   * synthetic adapter because no shipped one currently reaches the catalog that way: PF1e
   * reads a native `initiative`/`init` key, but `neutralCheckCatalog` normalises stats to
   * uppercase first and PF1e's reader matches lowercase only, so its native bonus resolves
   * to 0 through this path and IS incomplete. See the PR thread — that case-sensitivity is a
   * separate latent bug, not something to fix from a character-sheet change.
   */
  /**
   * The catalog hands adapters the STORED stats, not its own uppercased copy: PF1e reads a
   * native `initiative`/`init` bonus under those exact lowercase keys, and normalising first
   * silently resolved a valid initiative to 0 and reported "Initiative —".
   */
  test("PF1e's native initiative survives the catalog's key normalisation", () => {
    const initiativeOfPf1e = (stats: Record<string, number>) =>
      checkCatalogForAdapter(Pathfinder1eAdapter, { level: 3, stats, saveProficiencies: [], skills: {} })
        .find((c) => c.category === 'initiative');

    expect(initiativeOfPf1e({ initiative: 5 })).toMatchObject({ modifier: 5 });
    expect(initiativeOfPf1e({ initiative: 5 })?.incomplete).toBeFalsy();
    expect(initiativeOfPf1e({ init: 3 })).toMatchObject({ modifier: 3 });
    // DEX still works, and a sheet with neither is still honestly incomplete.
    expect(initiativeOfPf1e({ DEX: 16 })).toMatchObject({ modifier: 3 });
    expect(initiativeOfPf1e({ STR: 10 })?.incomplete).toBe(true);
  });

  /**
   * An adapter with a source outside the declared ability DECLARES it, via
   * `initiativeModifierOrNull` — the seam PF1e already uses. It is not inferred from the
   * number coming out non-zero, because a system can legitimately resolve to +0 from a real
   * source (#2115 review) and another can resolve non-zero from no source at all (13th Age's
   * level bonus, below).
   */
  test('an adapter that tracks provenance gets the final word', () => {
    const sourced = {
      ...Archmage13aAdapter,
      initiativeAbility: 'DEX',
      levelInitiativeBonus: undefined,
      initiativeModifier: () => 5,
      initiativeModifierOrNull: () => 5,
    } as unknown as typeof Archmage13aAdapter;
    const def = checkCatalogForAdapter(sourced, { level: 3, stats: { STR: 12 }, saveProficiencies: [], skills: {} })
      .find((c) => c.category === 'initiative');
    expect(def?.modifier).toBe(5);
    expect(def?.incomplete).toBeFalsy();

    // ...and the same adapter reporting no source is incomplete even though the numeric seam
    // still hands back a rollable 5.
    const unsourced = { ...sourced, initiativeModifierOrNull: () => null } as unknown as typeof Archmage13aAdapter;
    const missing = checkCatalogForAdapter(unsourced, { level: 3, stats: { STR: 12 }, saveProficiencies: [], skills: {} })
      .find((c) => c.category === 'initiative');
    expect(missing?.modifier).toBe(5);
    expect(missing?.incomplete).toBe(true);
  });

  test('a set ability score is complete, obviously', () => {
    const withDex = { level: 3, stats: { DEX: 16 }, saveProficiencies: [], skills: {} };
    expect(checkCatalogForAdapter(Archmage13aAdapter, withDex).find((c) => c.category === 'initiative')?.incomplete)
      .toBeFalsy();
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

/**
 * Codex review on #2115 — enforcing `hasInitiativeRoll` in the shared catalog stops the
 * ROLL, but an absent entry renders as "Initiative —", i.e. a nonexistent mechanic shown as
 * merely unset. The tile's own visibility therefore has to ask the capability directly; this
 * regressed once when the capability moved into the catalog and this half was assumed to
 * have moved with it, which is why it is a named function with its own test.
 */
test.describe('showsInitiativeTile — the tile asks the capability, not just the catalog', () => {
  test('a system with no initiative roll shows no tile', () => {
    expect(showsInitiativeTile(StarforgedAdapter)).toBe(false);
  });

  test('a group-initiative system shows no PER-CHARACTER tile, though it does roll', () => {
    const group = OSR_VARIANT_ADAPTERS['swords-wizardry'];
    expect(hasInitiativeRollForAdapter(group)).toBe(true);
    expect(showsInitiativeTile(group)).toBe(false);
  });

  test('individual-initiative systems keep the tile', () => {
    expect(showsInitiativeTile(Dnd5eAdapter)).toBe(true);
    expect(showsInitiativeTile(BasicFantasyAdapter)).toBe(true);
    expect(showsInitiativeTile(OpenLegendAdapter)).toBe(true);
  });
});

/**
 * Issue #1598 review — a "Critical Hit" damage roll must not be offered where the system has
 * no critical hit.
 *
 * The gate used to be the crit-damage FORMULA, which every adapter has (undeclared ones default
 * to 5e's `double-dice`). That answers "by how much", not "at all", so an OSR gear action with
 * dice damage got a Critical Hit menu item even though `createOsrVariantAdapter.resolveAttack`
 * returns only `hit` or `miss` — the sheet could commit a doubled total that resolving the same
 * item authoritatively can never produce.
 */
test.describe('allowsCriticalDamageRoll — crits are a capability, not a damage formula', () => {
  test('a system whose attack resolution has no crit tier is offered none', () => {
    for (const [id, adapter] of Object.entries(OSR_VARIANT_ADAPTERS)) {
      expect(allowsCriticalDamageRoll(adapter), id).toBe(false);
    }
  });

  test('Open Legend is offered none either — its exploding pool IS the escalation', () => {
    expect(allowsCriticalDamageRoll(OpenLegendAdapter)).toBe(false);
  });

  /**
   * A guard rather than a list: an adapter that owns its attack roll is the only kind that can
   * withhold `crit`, and this drives each one's real `resolveAttack` across every d20 face and
   * a wide modifier/AC range. If none of those rolls can produce a crit, the adapter must say
   * so — otherwise the next system added with its own hit/miss resolver silently inherits a
   * crit control again, which is exactly how OSR and Open Legend each got here.
   */
  test('every adapter whose attack roll cannot crit declares it', () => {
    const everyAdapter = [...listRuleSystemAdapters(), ...Object.values(OSR_VARIANT_ADAPTERS)];
    for (const adapter of everyAdapter) {
      if (!hasAdapterOwnedAttackRoll(adapter)) continue;
      let sawCrit = false;
      for (let face = 1; face <= 20 && !sawCrit; face += 1) {
        for (let targetAc = -5; targetAc <= 30 && !sawCrit; targetAc += 5) {
          for (const modifier of [-2, 0, 3, 10]) {
            const result = adapter.resolveAttack!({
              modifier,
              targetAc,
              roll: (expr: string) => {
                const sides = Number(/d(\d+)/i.exec(expr)?.[1] ?? 20);
                const value = Math.min(face, sides);
                return { expr, rolls: [value], total: value };
              },
            });
            if (result.outcome === 'crit') { sawCrit = true; break; }
          }
        }
      }
      if (!sawCrit) expect(hasCriticalHitsForAdapter(adapter), adapter.id).toBe(false);
    }
  });

  test('5e keeps its crit — the default is unchanged for undeclared adapters', () => {
    expect(allowsCriticalDamageRoll(Dnd5eAdapter)).toBe(true);
    expect(allowsCriticalDamageRoll(Archmage13aAdapter)).toBe(true);
  });

  /**
   * Not a capability question — PF2e HAS crits. `critDamageExpr` doubles dice, and PF2e doubles
   * the total, so this control offers nothing rather than a number that is wrong for the system.
   */
  test('a double-total system is offered no chip rather than a dice-doubled one', () => {
    expect(allowsCriticalDamageRoll(Pf2eAdapter)).toBe(false);
  });
});

/**
 * #2115 review — an initiative check is "incomplete" when it has no SOURCE, not when its value
 * happens to be zero.
 *
 * PF1e stores a native flat Init bonus (`initiative` / `init`) that already folds in DEX and
 * feats, and `initiative: 0` is a perfectly ordinary declared bonus. A rule that inferred
 * provenance from a nonzero contribution read that as a missing score and replaced a real +0
 * with "—", so provenance is now ASKED via `initiativeModifierOrNull` where an adapter tracks
 * it, and falls back to ability presence where it does not.
 */
test.describe('initiative completeness asks for provenance, never infers it', () => {
  const catalogInitiative = (adapter: Parameters<typeof checkCatalogForAdapter>[0], stats: Record<string, number>) =>
    checkCatalogForAdapter(adapter, { level: 3, stats, saveProficiencies: [], skills: {} })
      .find((c) => c.category === 'initiative');

  test('a declared PF1e +0 is a real bonus, not a missing score', () => {
    const zero = catalogInitiative(Pathfinder1eAdapter, { initiative: 0 });
    expect(zero?.modifier).toBe(0);
    expect(zero?.incomplete).toBeFalsy();

    // The same value with no source at all IS incomplete.
    const none = catalogInitiative(Pathfinder1eAdapter, { STR: 10 });
    expect(none?.modifier).toBe(0);
    expect(none?.incomplete).toBe(true);
  });

  test('a native bonus survives even beside an unrelated score', () => {
    const native = catalogInitiative(Pathfinder1eAdapter, { init: 0, STR: 10 });
    expect(native?.incomplete).toBeFalsy();
  });

  /**
   * 13th Age adds `levelInitiativeBonus` on top of DEX, so a level-3 character with no DEX
   * still totals +3 — the case a total-based test would wave through.
   */
  test('a level bonus does not disguise a missing ability', () => {
    expect(catalogInitiative(Archmage13aAdapter, { STR: 12 })?.incomplete).toBe(true);
    expect(catalogInitiative(Archmage13aAdapter, { DEX: 14 })?.incomplete).toBeFalsy();
    expect(catalogInitiative(Dnd5eAdapter, { STR: 14 })?.incomplete).toBe(true);
    expect(catalogInitiative(Dnd5eAdapter, { DEX: 16 })?.incomplete).toBeFalsy();
  });
});
