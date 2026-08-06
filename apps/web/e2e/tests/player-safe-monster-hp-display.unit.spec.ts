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
import type { Combatant } from '@campfire/schema';
import { safeCombatant, safeCombatants } from '../../src/features/screen/playerSafe';

function monster(fields: Partial<Combatant>): Combatant {
  return { id: 1, kind: 'monster', name: 'Ogre', initiative: 3, conditions: [], ...fields } as Combatant;
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

  test("omitting the mode defaults to 'band' — unchanged behavior for existing callers", () => {
    const c = monster({ hpCurrent: null, hpMax: null, hpBand: 'critical' });
    const safe = safeCombatant(c);
    expect(safe.hpCurrent).toBeNull();
    expect(safe.hpBand).toBe('critical');
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
