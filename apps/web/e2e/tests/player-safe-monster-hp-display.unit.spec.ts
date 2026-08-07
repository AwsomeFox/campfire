/**
 * Client mirror of the server's per-encounter monsterHpDisplay dial (issue #1925).
 *
 * `safeCombatant` never makes its own hiding decision — the server has already applied
 * the encounter's mode to the `Combatant` it hands the client (real numbers in 'exact',
 * band-only in 'band', neither in 'hidden' except a 'down' band). This suite proves the
 * mirror carries that decision through unchanged for the cast-window projection, across
 * all three modes, including the always-shipped 'down' band in 'hidden' mode.
 */
import { expect, test } from '@playwright/test';
import type { Combatant, EncounterWithCombatants } from '@campfire/schema';
import { safeCombatant, safeCombatants, safeEncounterForCast } from '../../src/features/screen/playerSafe';

function monster(fields: Partial<Combatant>): Combatant {
  return { id: 1, kind: 'monster', name: 'Ogre', initiative: 3, conditions: [], ...fields } as Combatant;
}

function encounterFixture(fields: Partial<EncounterWithCombatants>): EncounterWithCombatants {
  return {
    id: 1,
    campaignId: 1,
    name: 'Fight',
    status: 'running',
    round: 1,
    currentCombatantId: null,
    turnPhase: 'combatant',
    mapAttachmentId: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    combatants: [],
    fog: null,
    aoe: [],
    ...fields,
  } as EncounterWithCombatants;
}

test.describe('safeCombatant — monsterHpDisplay mode matrix (issue #1925)', () => {
  test("'band' mode (default): exact numbers withheld, coarse band shown", () => {
    const c = monster({ hpCurrent: null, hpMax: null, hpBand: 'bloodied' });
    const safe = safeCombatant(c, 'band');
    expect(safe.hpCurrent).toBeNull();
    expect(safe.hpMax).toBeNull();
    expect(safe.hpBand).toBe('bloodied');
    expect(safe.down).toBe(false);
  });

  // Issue #1925 review (finding #2): a client that "repairs" a server-side numbers
  // leak into a plausible band would destroy the only visible evidence of that leak.
  // In 'hidden' mode, safeCombatant must NEVER derive a band (or a down state) from
  // hpCurrent/hpMax, even if those numbers happen to be present on the wire object —
  // it must render as if it received nothing, not invent something plausible.
  test("'hidden' mode ignores hpCurrent/hpMax entirely, even if the server accidentally sent them (defense in depth)", () => {
    const c = monster({ hpCurrent: 40, hpMax: 100, hpBand: null });
    const safe = safeCombatant(c, 'hidden');
    expect(safe.hpCurrent).toBeNull();
    expect(safe.hpMax).toBeNull();
    // Must NOT derive 'bloodied' from 40/100 — that would mask the leak.
    expect(safe.hpBand).toBeNull();
    expect(safe.down).toBe(false);
  });

  test("'hidden' mode does not derive 'down' from a leaked hpCurrent<=0 either — only an explicit 'down' band counts", () => {
    const c = monster({ hpCurrent: 0, hpMax: 100, hpBand: null });
    const safe = safeCombatant(c, 'hidden');
    expect(safe.hpCurrent).toBeNull();
    expect(safe.hpBand).toBeNull();
    expect(safe.down).toBe(false);
  });

  test("'exact' mode: the server-sent real numbers are carried through, not stripped", () => {
    const c = monster({ hpCurrent: 40, hpMax: 100, hpBand: 'bloodied' });
    const safe = safeCombatant(c, 'exact');
    expect(safe.hpCurrent).toBe(40);
    expect(safe.hpMax).toBe(100);
    // Numbers and band are mutually exclusive on SafeCombatant — the exact numbers
    // already convey everything the band would.
    expect(safe.hpBand).toBeNull();
    expect(safe.down).toBe(false);
  });

  test("'hidden' mode: neither the number nor the band is shown for a live monster", () => {
    const c = monster({ hpCurrent: null, hpMax: null, hpBand: null });
    const safe = safeCombatant(c, 'hidden');
    expect(safe.hpCurrent).toBeNull();
    expect(safe.hpMax).toBeNull();
    expect(safe.hpBand).toBeNull();
    expect(safe.down).toBe(false);
  });

  test("'hidden' mode still surfaces the 'down' band for a monster at 0 HP", () => {
    const c = monster({ hpCurrent: null, hpMax: null, hpBand: 'down' });
    const safe = safeCombatant(c, 'hidden');
    expect(safe.hpCurrent).toBeNull();
    expect(safe.hpMax).toBeNull();
    expect(safe.hpBand).toBe('down');
    expect(safe.down).toBe(true);
  });

  test("a character always keeps exact HP regardless of monsterHpDisplay", () => {
    const c = {
      id: 2,
      kind: 'character',
      name: 'Aria',
      initiative: 5,
      conditions: [],
      hpCurrent: 12,
      hpMax: 20,
      hpBand: null,
    } as unknown as Combatant;
    for (const mode of ['band', 'exact', 'hidden'] as const) {
      const safe = safeCombatant(c, mode);
      expect(safe.hpCurrent).toBe(12);
      expect(safe.hpMax).toBe(20);
      expect(safe.hpBand).toBeNull();
    }
  });

  test('safeCombatants threads the mode through the whole roster', () => {
    const roster = [
      monster({ id: 1, hpCurrent: 22, hpMax: 22, hpBand: 'healthy' }),
      {
        id: 2,
        kind: 'monster',
        name: 'Ogre 2',
        initiative: 1,
        conditions: [],
        hpCurrent: 22,
        hpMax: 22,
        hpBand: 'healthy',
        hidden: true,
      } as unknown as Combatant,
    ];
    const safe = safeCombatants(roster, 'exact');
    // The hidden(-from-players) combatant is dropped wholesale; the visible one keeps
    // its exact numbers because the encounter is in 'exact' mode.
    expect(safe).toHaveLength(1);
    expect(safe[0]!.hpCurrent).toBe(22);
    expect(safe[0]!.hpMax).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// Issue #1925 review (finding #1, PR #2040): the Cast map scene projects combatants
// through `safeEncounterForCast` -> `redactCombatantForCast` -> `safeCombatant`,
// a SEPARATE path from the initiative scene's `safeCombatants`. Before this fix,
// `redactCombatantForCast` called `safeCombatant(c)` with no mode, silently taking
// the (then-default) 'band' branch regardless of the encounter's actual mode — so on
// an 'exact' table the map scene's tokens disagreed with the initiative scene on the
// very same screen. These tests prove both scenes now agree, in all three modes.
test.describe("safeEncounterForCast agrees with safeCombatants on monsterHpDisplay (issue #1925 finding #1)", () => {
  test("'exact' mode: the map scene ships real numbers, matching the initiative scene", () => {
    const enc = encounterFixture({
      monsterHpDisplay: 'exact',
      combatants: [monster({ id: 1, hpCurrent: 40, hpMax: 100, hpBand: 'bloodied' })],
    });
    const mapScene = safeEncounterForCast(enc);
    const initiativeScene = safeCombatants(enc.combatants, enc.monsterHpDisplay);
    const mapCombatant = mapScene.combatants[0]!;
    expect(mapCombatant.hpCurrent).toBe(40);
    expect(mapCombatant.hpMax).toBe(100);
    expect(mapCombatant.hpBand).toBeNull();
    // The two scenes must agree exactly, not just individually look "safe".
    expect(mapCombatant.hpCurrent).toBe(initiativeScene[0]!.hpCurrent);
    expect(mapCombatant.hpMax).toBe(initiativeScene[0]!.hpMax);
  });

  test("'band' mode: the map scene ships only the coarse band, matching the initiative scene", () => {
    const enc = encounterFixture({
      monsterHpDisplay: 'band',
      combatants: [monster({ id: 1, hpCurrent: null, hpMax: null, hpBand: 'critical' })],
    });
    const mapScene = safeEncounterForCast(enc);
    const initiativeScene = safeCombatants(enc.combatants, enc.monsterHpDisplay);
    const mapCombatant = mapScene.combatants[0]!;
    expect(mapCombatant.hpCurrent).toBeNull();
    expect(mapCombatant.hpBand).toBe('critical');
    expect(mapCombatant.hpBand).toBe(initiativeScene[0]!.hpBand);
  });

  test("'hidden' mode: the map scene ships neither number nor band, matching the initiative scene", () => {
    const enc = encounterFixture({
      monsterHpDisplay: 'hidden',
      combatants: [monster({ id: 1, hpCurrent: null, hpMax: null, hpBand: null })],
    });
    const mapScene = safeEncounterForCast(enc);
    const initiativeScene = safeCombatants(enc.combatants, enc.monsterHpDisplay);
    const mapCombatant = mapScene.combatants[0]!;
    expect(mapCombatant.hpCurrent).toBeNull();
    expect(mapCombatant.hpBand).toBeNull();
    expect(mapCombatant.hpBand).toBe(initiativeScene[0]!.hpBand);
  });

  test("'hidden' mode: a downed monster still shows 'down' on the map scene, matching the initiative scene", () => {
    const enc = encounterFixture({
      monsterHpDisplay: 'hidden',
      combatants: [monster({ id: 1, hpCurrent: null, hpMax: null, hpBand: 'down' })],
    });
    const mapScene = safeEncounterForCast(enc);
    const initiativeScene = safeCombatants(enc.combatants, enc.monsterHpDisplay);
    const mapCombatant = mapScene.combatants[0]!;
    expect(mapCombatant.hpBand).toBe('down');
    expect(mapCombatant.hpBand).toBe(initiativeScene[0]!.hpBand);
  });
});
