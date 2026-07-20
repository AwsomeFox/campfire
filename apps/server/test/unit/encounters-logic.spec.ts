import type { Combatant, EncounterStatus } from '@campfire/schema';
import {
  abilityMod,
  sortCombatants,
  turnIndexFor,
  advanceTurn,
  hpBandFor,
} from '../../src/modules/encounters/encounters.logic';

/**
 * Unit tests for the pure combat-order / turn / HP-band math extracted from
 * EncountersService (issue #79). No DB, no Nest — just data in, data out.
 */

/** Minimal Combatant factory; only the fields the logic reads matter. */
function combatant(over: Partial<Combatant> & { id: number }): Combatant {
  return {
    encounterId: 1,
    kind: 'monster',
    characterId: null,
    name: `c${over.id}`,
    initiative: null,
    initMod: 0,
    hpCurrent: null,
    hpMax: null,
    hpBand: null,
    conditions: [],
    ruleEntryId: null,
    sortOrder: 0,
    ...over,
  } as Combatant;
}

describe('encounters — abilityMod', () => {
  it.each<[number, number]>([
    [10, 0],
    [11, 0],
    [12, 1],
    [8, -1],
    [7, -2],
    [20, 5],
    [1, -5],
    [18, 4],
  ])('score %i -> modifier %i', (score, mod) => {
    expect(abilityMod(score)).toBe(mod);
  });
});

describe('encounters — sortCombatants', () => {
  it('non-running: orders by sortOrder ascending', () => {
    const rows = [combatant({ id: 3, sortOrder: 2 }), combatant({ id: 1, sortOrder: 0 }), combatant({ id: 2, sortOrder: 1 })];
    for (const status of ['preparing', 'ended'] as EncounterStatus[]) {
      expect(sortCombatants(rows, status).map((c) => c.id)).toEqual([1, 2, 3]);
    }
  });

  it('running: orders by initiative descending', () => {
    const rows = [
      combatant({ id: 1, initiative: 12, sortOrder: 0 }),
      combatant({ id: 2, initiative: 20, sortOrder: 1 }),
      combatant({ id: 3, initiative: 5, sortOrder: 2 }),
    ];
    expect(sortCombatants(rows, 'running').map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it('running: null initiative sinks to the bottom', () => {
    const rows = [
      combatant({ id: 1, initiative: null, sortOrder: 0 }),
      combatant({ id: 2, initiative: 15, sortOrder: 1 }),
    ];
    expect(sortCombatants(rows, 'running').map((c) => c.id)).toEqual([2, 1]);
  });

  it('running: ties break by sortOrder ascending', () => {
    const rows = [
      combatant({ id: 1, initiative: 15, sortOrder: 2 }),
      combatant({ id: 2, initiative: 15, sortOrder: 1 }),
    ];
    expect(sortCombatants(rows, 'running').map((c) => c.id)).toEqual([2, 1]);
  });

  it('running: two nulls keep sortOrder order', () => {
    const rows = [
      combatant({ id: 1, initiative: null, sortOrder: 1 }),
      combatant({ id: 2, initiative: null, sortOrder: 0 }),
    ];
    expect(sortCombatants(rows, 'running').map((c) => c.id)).toEqual([2, 1]);
  });

  it('does not mutate the input array', () => {
    const rows = [combatant({ id: 2, sortOrder: 1 }), combatant({ id: 1, sortOrder: 0 })];
    const before = rows.map((c) => c.id);
    sortCombatants(rows, 'preparing');
    expect(rows.map((c) => c.id)).toEqual(before);
  });
});

describe('encounters — turnIndexFor', () => {
  const sorted = [combatant({ id: 7 }), combatant({ id: 8 }), combatant({ id: 9 })];

  it('returns the position of the current combatant', () => {
    expect(turnIndexFor(sorted, 8)).toBe(1);
    expect(turnIndexFor(sorted, 7)).toBe(0);
  });

  it('returns 0 when there is no current combatant', () => {
    expect(turnIndexFor(sorted, null)).toBe(0);
  });

  it('returns 0 when the current combatant is no longer present', () => {
    expect(turnIndexFor(sorted, 999)).toBe(0);
  });
});

describe('encounters — advanceTurn (current-turn math)', () => {
  const sorted = [combatant({ id: 7 }), combatant({ id: 8 }), combatant({ id: 9 })];

  it('steps to the next combatant within the same round', () => {
    expect(advanceTurn(sorted, 7, 1)).toEqual({ turnIndex: 1, round: 1, currentCombatantId: 8 });
  });

  it('wraps past the end and increments the round', () => {
    expect(advanceTurn(sorted, 9, 1)).toEqual({ turnIndex: 0, round: 2, currentCombatantId: 7 });
  });

  it('a null pointer restarts at the top of the current round', () => {
    expect(advanceTurn(sorted, null, 3)).toEqual({ turnIndex: 0, round: 3, currentCombatantId: 7 });
  });

  it('a stale pointer (removed actor) restarts at the top', () => {
    expect(advanceTurn(sorted, 999, 2)).toEqual({ turnIndex: 0, round: 2, currentCombatantId: 7 });
  });

  it('an empty encounter clears the pointer without advancing the round', () => {
    expect(advanceTurn([], 5, 4)).toEqual({ turnIndex: 0, round: 4, currentCombatantId: null });
  });

  it('a single-combatant encounter loops on itself, bumping the round', () => {
    const solo = [combatant({ id: 1 })];
    expect(advanceTurn(solo, 1, 1)).toEqual({ turnIndex: 0, round: 2, currentCombatantId: 1 });
  });

  it('walks a full round and back to the start', () => {
    let state = { turnIndex: 0, round: 1, currentCombatantId: 7 as number | null };
    const seen: Array<number | null> = [state.currentCombatantId];
    for (let i = 0; i < 3; i++) {
      state = advanceTurn(sorted, state.currentCombatantId, state.round);
      seen.push(state.currentCombatantId);
    }
    expect(seen).toEqual([7, 8, 9, 7]);
    expect(state.round).toBe(2);
  });
});

describe('encounters — hpBandFor (issue #43)', () => {
  it('is down at 0 or below', () => {
    expect(hpBandFor(0, 100)).toBe('down');
    expect(hpBandFor(-10, 100)).toBe('down');
  });

  it('is critical at or below 25%', () => {
    expect(hpBandFor(25, 100)).toBe('critical');
    expect(hpBandFor(1, 100)).toBe('critical');
  });

  it('is bloodied between 25% and 50%', () => {
    expect(hpBandFor(50, 100)).toBe('bloodied');
    expect(hpBandFor(26, 100)).toBe('bloodied');
  });

  it('is healthy above 50%', () => {
    expect(hpBandFor(51, 100)).toBe('healthy');
    expect(hpBandFor(100, 100)).toBe('healthy');
  });

  it('treats a zero max defensively (full-hp guard) as down when current<=0, else non-healthy', () => {
    expect(hpBandFor(0, 0)).toBe('down');
    // current>0 with max 0 -> pct 0 -> critical (never divides by zero)
    expect(hpBandFor(5, 0)).toBe('critical');
  });
});
