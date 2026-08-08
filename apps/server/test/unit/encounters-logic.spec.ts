import type { Combatant, EncounterEvent, EncounterStatus } from '@campfire/schema';
import {
  CombatantTurnState,
  Dnd5eAdapter,
  DND5E_HP_MODEL,
  hasDeathSavesForAdapter,
  hpModelForAdapter,
  listRuleSystemAdapters,
  MAX_PENDING_CONCENTRATION_CHECKS,
  NEUTRAL_HP_MODEL,
  Pf2eAdapter,
} from '@campfire/schema';
import {
  abilityMod,
  sortCombatants,
  sortEncountersForList,
  turnIndexFor,
  advanceTurn,
  initialEncounterTurnState,
  retreatTurn,
  shouldSkipTurnOnAdvance,
  hpBandFor,
  applyCombatantHp,
  enqueueConcentrationCheck,
  parseCr,
  crToXp,
  xpThresholdsForLevel,
  encounterMultiplier,
  computeEncounterDifficulty,
  mulberry32,
  generateEncounterGroup,
  redactEncounterEventsForViewer,
  UNKNOWN_COMBATANT_LABEL,
  rollRechargeAtTurnStart,
  undoActionUsesRecharge,
} from '../../src/modules/encounters/encounters.logic';
import type { CombatantHpState, GeneratorCandidate } from '../../src/modules/encounters/encounters.logic';

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

describe('encounters — sortEncountersForList', () => {
  function row(id: number, status: EncounterStatus, updatedAt: string) {
    return { id, status, updatedAt };
  }

  it('groups running → preparing → ended, then updatedAt desc within each group', () => {
    const sorted = sortEncountersForList([
      row(1, 'ended', '2026-01-01T00:00:00.000Z'),
      row(2, 'running', '2026-01-02T00:00:00.000Z'),
      row(3, 'preparing', '2026-01-03T00:00:00.000Z'),
      row(4, 'ended', '2026-01-04T00:00:00.000Z'),
      row(5, 'preparing', '2026-01-05T00:00:00.000Z'),
    ]);
    expect(sorted.map((e) => e.id)).toEqual([2, 5, 3, 4, 1]);
  });

  it('pins the authoritative running fight to the top when multiple running rows exist', () => {
    const sorted = sortEncountersForList(
      [
        row(10, 'running', '2026-01-10T00:00:00.000Z'),
        row(20, 'running', '2026-01-20T00:00:00.000Z'),
        row(30, 'preparing', '2026-01-30T00:00:00.000Z'),
      ],
      { pinActiveId: 10 },
    );
    expect(sorted.map((e) => e.id)).toEqual([10, 20, 30]);
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

  it('running: ties break by sortOrder ascending when no adapter tiebreak is supplied', () => {
    const rows = [
      combatant({ id: 1, initiative: 15, sortOrder: 2 }),
      combatant({ id: 2, initiative: 15, sortOrder: 1 }),
    ];
    expect(sortCombatants(rows, 'running').map((c) => c.id)).toEqual([2, 1]);
  });

  /**
   * Issue #1923's manual-order override must be *absent* here, not merely unused. The
   * `combatant()` helper above ends in `as Combatant`, so a field it does not set is
   * `undefined` at runtime while TypeScript stays quiet — and the first version of the
   * override tested `manualOrder !== null`, which `undefined` passes. The subtraction then
   * produced NaN, the comparator returned NaN, and the whole tie group came back in an
   * arbitrary order; that is what broke the four adapter-tiebreak cases in this file.
   *
   * These two pin the boundary explicitly rather than leaving it implied by fixtures that
   * happen to omit the field.
   */
  describe('manual-order override (issue #1923)', () => {
    it('an undefined manualOrder is treated as absent, not as a position — the adapter tiebreak still decides', () => {
      const rows = [
        combatant({ id: 1, initiative: 15, initMod: 1, sortOrder: 0 }),
        combatant({ id: 2, initiative: 15, initMod: 3, sortOrder: 1 }),
      ];
      // Neither row has the field at all. Higher initMod must win, exactly as before the
      // override existed. A NaN comparator returns insertion order [1, 2] here instead.
      expect(rows.every((r) => r.manualOrder === undefined)).toBe(true);
      expect(sortCombatants(rows, 'running', (a, b) => Dnd5eAdapter.initiativeTiebreak(a, b)).map((c) => c.id)).toEqual([2, 1]);
    });

    it('when BOTH rows carry a manualOrder it overrides the adapter tiebreak, even against a higher initMod', () => {
      const rows = [
        combatant({ id: 1, initiative: 15, initMod: 1, sortOrder: 0, manualOrder: 0 }),
        combatant({ id: 2, initiative: 15, initMod: 3, sortOrder: 1, manualOrder: 1 }),
      ];
      // The adapter alone would order [2, 1] (initMod 3 beats 1) — the DM's placement wins.
      expect(sortCombatants(rows, 'running', (a, b) => Dnd5eAdapter.initiativeTiebreak(a, b)).map((c) => c.id)).toEqual([1, 2]);
    });

    it('a stamped row precedes an unstamped one, beating the adapter tiebreak', () => {
      const rows = [
        combatant({ id: 1, initiative: 15, initMod: 1, sortOrder: 0, manualOrder: 0 }),
        combatant({ id: 2, initiative: 15, initMod: 3, sortOrder: 1 }),
      ];
      // The adapter alone would put 2 first (initMod 3 > 1). A combatant added after the
      // DM's reorder joins the END of the tie group instead — see the transitivity case
      // right below for why this is a rule, not a preference.
      expect(sortCombatants(rows, 'running', (a, b) => Dnd5eAdapter.initiativeTiebreak(a, b)).map((c) => c.id)).toEqual([1, 2]);
    });

    /**
     * Issue #2084's narrower stamp (moved combatant + the same-tie-group rows it actually
     * crossed, not the whole roster) makes a tie group mixing stamped and unstamped rows
     * the ORDINARY case rather than a rare one — so the total-order rule below (originally
     * #2074 review round 3, relanded as #2088) is load-bearing here, not incidental.
     * Deciding different pairs in one tie group by different rules makes the comparator
     * non-transitive, and `Array.prototype.sort` then returns an implementation-defined
     * order — which `sortCombatants` also feeds into `turnIndex`.
     */
    it('a tie mixing stamped and unstamped rows sorts totally, with no cycle and no dependence on input order', () => {
      // A < B by manualOrder, B < C by initMod, C < A by initMod — a cycle if all three
      // rules were consulted independently pairwise.
      const a = combatant({ id: 1, initiative: 14, initMod: 1, sortOrder: 0, manualOrder: 0 });
      const b = combatant({ id: 2, initiative: 14, initMod: 3, sortOrder: 1, manualOrder: 1 });
      const c = combatant({ id: 3, initiative: 14, initMod: 2, sortOrder: 2 });
      const expected = [1, 2, 3];

      // Every permutation must land on the same order. A cyclic comparator does not.
      for (const perm of [
        [a, b, c],
        [a, c, b],
        [b, a, c],
        [b, c, a],
        [c, a, b],
        [c, b, a],
      ]) {
        expect(sortCombatants(perm, 'running', (x, y) => Dnd5eAdapter.initiativeTiebreak(x, y)).map((r) => r.id)).toEqual(expected);
      }
    });
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

  // Issue #611 — per-adapter initiative tiebreak on equal totals.
  describe('adapter tiebreak (issue #611)', () => {
    it('5e: higher initMod (DEX) wins a tied initiative, ignoring later sortOrder', () => {
      // Same total 14; id 1 was added first (sortOrder 0) but has lower DEX.
      // Without DEX tiebreak, sortOrder would put id 1 first — wrong for 5e.
      const rows = [
        combatant({ id: 1, initiative: 14, initMod: 1, sortOrder: 0 }),
        combatant({ id: 2, initiative: 14, initMod: 3, sortOrder: 1 }),
      ];
      expect(
        sortCombatants(rows, 'running', (a, b) => Dnd5eAdapter.initiativeTiebreak(a, b)).map((c) => c.id),
      ).toEqual([2, 1]);
    });

    it('5e: equal initMod falls back to sortOrder ascending (stable / DM-reorder fallback)', () => {
      const rows = [
        combatant({ id: 1, initiative: 14, initMod: 2, sortOrder: 2 }),
        combatant({ id: 2, initiative: 14, initMod: 2, sortOrder: 0 }),
        combatant({ id: 3, initiative: 14, initMod: 2, sortOrder: 1 }),
      ];
      expect(
        sortCombatants(rows, 'running', (a, b) => Dnd5eAdapter.initiativeTiebreak(a, b)).map((c) => c.id),
      ).toEqual([2, 3, 1]);
    });

    it('PF2e: preserves sortOrder on a tie — does NOT re-sort by initMod/DEX', () => {
      // Higher initMod on the later-added combatant must NOT jump ahead in PF2e.
      const rows = [
        combatant({ id: 1, initiative: 18, initMod: 1, sortOrder: 0 }),
        combatant({ id: 2, initiative: 18, initMod: 5, sortOrder: 1 }),
      ];
      expect(
        sortCombatants(rows, 'running', (a, b) => Pf2eAdapter.initiativeTiebreak(a, b)).map((c) => c.id),
      ).toEqual([1, 2]);
    });

    it('PF2e: equal initiative keeps insertion/roll order even when initMods differ wildly', () => {
      const rows = [
        combatant({ id: 3, initiative: 10, initMod: 9, sortOrder: 2 }),
        combatant({ id: 1, initiative: 10, initMod: -1, sortOrder: 0 }),
        combatant({ id: 2, initiative: 10, initMod: 4, sortOrder: 1 }),
      ];
      expect(
        sortCombatants(rows, 'running', (a, b) => Pf2eAdapter.initiativeTiebreak(a, b)).map((c) => c.id),
      ).toEqual([1, 2, 3]);
    });

    it('5e: unrolled (null/null) combatants keep sortOrder — adapter DEX must not reshuffle', () => {
      // Higher DEX on the later-added unrolled combatant must NOT jump ahead before roll.
      const rows = [
        combatant({ id: 1, initiative: null, initMod: 1, sortOrder: 0 }),
        combatant({ id: 2, initiative: null, initMod: 5, sortOrder: 1 }),
      ];
      expect(
        sortCombatants(rows, 'running', (a, b) => Dnd5eAdapter.initiativeTiebreak(a, b)).map((c) => c.id),
      ).toEqual([1, 2]);
    });
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
    expect(advanceTurn(sorted, 7, 1)).toEqual({ turnIndex: 1, round: 1, currentCombatantId: 8, skipped: [] });
  });

  it('wraps past the end and increments the round', () => {
    expect(advanceTurn(sorted, 9, 1)).toEqual({ turnIndex: 0, round: 2, currentCombatantId: 7, skipped: [] });
  });

  it('a null pointer restarts at the top of the current round', () => {
    expect(advanceTurn(sorted, null, 3)).toEqual({ turnIndex: 0, round: 3, currentCombatantId: 7, skipped: [] });
  });

  it('a stale pointer (removed actor) restarts at the top', () => {
    expect(advanceTurn(sorted, 999, 2)).toEqual({ turnIndex: 0, round: 2, currentCombatantId: 7, skipped: [] });
  });

  it('an empty encounter clears the pointer without advancing the round', () => {
    expect(advanceTurn([], 5, 4)).toEqual({ turnIndex: 0, round: 4, currentCombatantId: null, skipped: [] });
  });

  it('a single-combatant encounter loops on itself, bumping the round', () => {
    const solo = [combatant({ id: 1 })];
    expect(advanceTurn(solo, 1, 1)).toEqual({ turnIndex: 0, round: 2, currentCombatantId: 1, skipped: [] });
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

describe('encounters — shouldSkipTurnOnAdvance (issue #610)', () => {
  it('skips dead combatants', () => {
    expect(shouldSkipTurnOnAdvance(combatant({ id: 1, kind: 'character', deathState: 'dead' }))).toBe(true);
  });

  it('skips stable PCs', () => {
    expect(shouldSkipTurnOnAdvance(combatant({ id: 1, kind: 'character', deathState: 'stable', hpCurrent: 0 }))).toBe(true);
  });

  it('does not skip dying PCs (death-save turn)', () => {
    expect(shouldSkipTurnOnAdvance(combatant({ id: 1, kind: 'character', deathState: 'dying', hpCurrent: 0 }))).toBe(false);
  });

  it('skips monsters and NPCs at 0 HP', () => {
    expect(shouldSkipTurnOnAdvance(combatant({ id: 1, kind: 'monster', hpCurrent: 0, hpMax: 10 }))).toBe(true);
    expect(shouldSkipTurnOnAdvance(combatant({ id: 2, kind: 'npc', hpCurrent: 0, hpMax: 10 }))).toBe(true);
  });

  it('does not skip living combatants', () => {
    expect(shouldSkipTurnOnAdvance(combatant({ id: 1, kind: 'monster', hpCurrent: 5, hpMax: 10 }))).toBe(false);
    expect(shouldSkipTurnOnAdvance(combatant({ id: 2, kind: 'character', hpCurrent: 5, hpMax: 10, deathState: 'none' }))).toBe(false);
  });
});

describe('encounters — advanceTurn skips dead/downed (issue #610)', () => {
  it('skips a defeated monster between two living combatants', () => {
    const order = [
      combatant({ id: 1, hpCurrent: 10, hpMax: 10 }),
      combatant({ id: 2, hpCurrent: 0, hpMax: 10 }),
      combatant({ id: 3, hpCurrent: 8, hpMax: 10 }),
    ];
    const result = advanceTurn(order, 1, 1);
    expect(result.currentCombatantId).toBe(3);
    expect(result.round).toBe(1);
    expect(result.skipped).toEqual([{ id: 2, name: 'c2', round: 1 }]);
  });

  it('still lands on a dying PC for death saves', () => {
    const order = [
      combatant({ id: 1, kind: 'character', hpCurrent: 10, hpMax: 10, deathState: 'none' }),
      combatant({ id: 2, kind: 'character', hpCurrent: 0, hpMax: 10, deathState: 'dying' }),
      combatant({ id: 3, hpCurrent: 8, hpMax: 10 }),
    ];
    const result = advanceTurn(order, 1, 1);
    expect(result.currentCombatantId).toBe(2);
    expect(result.skipped).toEqual([]);
  });

  it('skips multiple consecutive defeated combatants and wraps', () => {
    const order = [
      combatant({ id: 1, hpCurrent: 10, hpMax: 10 }),
      combatant({ id: 2, hpCurrent: 0, hpMax: 10 }),
      combatant({ id: 3, hpCurrent: 0, hpMax: 10 }),
    ];
    const result = advanceTurn(order, 1, 1);
    expect(result.currentCombatantId).toBe(1);
    expect(result.round).toBe(2);
    expect(result.skipped.map((s) => s.id)).toEqual([2, 3]);
    expect(result.skipped.map((s) => s.round)).toEqual([1, 1]);
  });

  it('returns null when every combatant is skippable', () => {
    const order = [
      combatant({ id: 1, hpCurrent: 0, hpMax: 10 }),
      combatant({ id: 2, hpCurrent: 0, hpMax: 10 }),
    ];
    const result = advanceTurn(order, 1, 1);
    expect(result.currentCombatantId).toBeNull();
    expect(result.round).toBe(2);
    expect(result.skipped.map((s) => s.id)).toEqual([2, 1]);
    expect(result.skipped.map((s) => s.round)).toEqual([1, 2]);
  });

  it('caps round to a single wrap for a solo skippable combatant', () => {
    const solo = [combatant({ id: 1, hpCurrent: 0, hpMax: 10 })];
    const result = advanceTurn(solo, 1, 1);
    expect(result.currentCombatantId).toBeNull();
    expect(result.round).toBe(2);
    expect(result.skipped).toEqual([{ id: 1, name: 'c1', round: 2 }]);
  });
});

describe('encounters — retreatTurn skips dead/downed (issue #610)', () => {
  it('undoes an advance that skipped a defeated combatant', () => {
    const order = [
      combatant({ id: 1, hpCurrent: 10, hpMax: 10 }),
      combatant({ id: 2, hpCurrent: 0, hpMax: 10 }),
      combatant({ id: 3, hpCurrent: 8, hpMax: 10 }),
    ];
    const advanced = advanceTurn(order, 1, 1);
    expect(advanced.currentCombatantId).toBe(3);
    const undone = retreatTurn(order, advanced.currentCombatantId, advanced.round);
    expect(undone.currentCombatantId).toBe(1);
    expect(undone.round).toBe(1);
  });

  it('skips backward over multiple defeated combatants', () => {
    const order = [
      combatant({ id: 1, hpCurrent: 10, hpMax: 10 }),
      combatant({ id: 2, hpCurrent: 0, hpMax: 10 }),
      combatant({ id: 3, hpCurrent: 0, hpMax: 10 }),
    ];
    const advanced = advanceTurn(order, 1, 1);
    expect(advanced.currentCombatantId).toBe(1);
    expect(advanced.round).toBe(2);
    const undone = retreatTurn(order, advanced.currentCombatantId, advanced.round);
    expect(undone.currentCombatantId).toBe(1);
    expect(undone.round).toBe(1);
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

describe('encounters — applyCombatantHp (issue #57 5e HP model)', () => {
  function charState(over: Partial<CombatantHpState> = {}): CombatantHpState {
    return {
      kind: 'character',
      hpCurrent: 20,
      hpMax: 20,
      hpTemp: 0,
      deathState: 'none',
      deathSaveSuccesses: 0,
      deathSaveFailures: 0,
      ...over,
    };
  }

  describe('temp HP', () => {
    it('absorbs damage before real HP and does not stack past what is set', () => {
      const r = applyCombatantHp(charState({ hpTemp: 5 }), { hpDelta: -3 });
      expect(r.hpTemp).toBe(2); // 3 soaked from the 5 temp pool
      expect(r.hpCurrent).toBe(20); // real HP untouched
    });

    it('spills over into real HP once the temp pool is exhausted', () => {
      const r = applyCombatantHp(charState({ hpTemp: 5 }), { hpDelta: -8 });
      expect(r.hpTemp).toBe(0);
      expect(r.hpCurrent).toBe(17); // 5 to temp, remaining 3 to real HP
    });

    it('an explicit hpTemp set can exceed nothing/is independent of hpMax', () => {
      const r = applyCombatantHp(charState({ hpMax: 10, hpCurrent: 10 }), { hpTemp: 25 });
      expect(r.hpTemp).toBe(25);
      expect(r.hpCurrent).toBe(10);
    });

    it('healing does not touch the temp pool', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 10, hpTemp: 4 }), { hpDelta: 5 });
      expect(r.hpCurrent).toBe(15);
      expect(r.hpTemp).toBe(4);
    });
  });

  describe('concentration checks (issue #606)', () => {
    it('flags an authoritative DC 10 check when a concentrating caster takes minor damage', () => {
      const r = applyCombatantHp(charState({ isConcentrating: true }), { hpDelta: -8 });
      expect(r.concentrationCheck).toEqual({ damage: 8, dc: 10 });
    });

    it('uses half the actual damage, rounded down, and includes damage absorbed by temporary HP', () => {
      const r = applyCombatantHp(charState({ isConcentrating: true, hpTemp: 5 }), { hpDelta: -25 });
      expect(r.concentrationCheck).toEqual({ damage: 25, dc: 12 });
    });

    it('uses the full effective hit for an overkill concentration check', () => {
      const r = applyCombatantHp(
        charState({ isConcentrating: true, hpCurrent: 5, hpMax: 5 }),
        { hpDelta: -25 },
      );
      expect(r.concentrationCheck).toEqual({ damage: 25, dc: 12 });
    });

    it('does not flag healing or damage for a combatant without concentration', () => {
      expect(applyCombatantHp(charState({ isConcentrating: true }), { hpDelta: 5 }).concentrationCheck).toBeNull();
      expect(applyCombatantHp(charState(), { hpDelta: -25 }).concentrationCheck).toBeNull();
    });

    it('does not treat administrative HP or temporary-HP edits as damage', () => {
      const concentrating = charState({ isConcentrating: true, hpCurrent: 20, hpTemp: 5 });
      expect(applyCombatantHp(concentrating, { hpSet: 1 }).concentrationCheck).toBeNull();
      expect(applyCombatantHp(concentrating, { hpTemp: 0 }).concentrationCheck).toBeNull();
      expect(applyCombatantHp(concentrating, { hpSet: 1, hpDelta: -20 }).concentrationCheck).toBeNull();
    });

    it('bounds and de-duplicates the durable queue', () => {
      let state = CombatantTurnState.parse({});
      for (let i = 0; i < MAX_PENDING_CONCENTRATION_CHECKS + 3; i += 1) {
        state = enqueueConcentrationCheck(state, { id: `check-${i}`, damage: i + 1, dc: 10 });
      }
      expect(state.pendingConcentrationChecks).toHaveLength(MAX_PENDING_CONCENTRATION_CHECKS);
      expect(state.pendingConcentrationChecks[0].id).toBe('check-3');

      state = enqueueConcentrationCheck(state, { id: 'check-22', damage: 99, dc: 50 });
      expect(state.pendingConcentrationChecks).toHaveLength(MAX_PENDING_CONCENTRATION_CHECKS);
      expect(state.pendingConcentrationChecks.at(-1)).toEqual({ id: 'check-22', damage: 99, dc: 50 });
    });
  });

  describe('death saves + dying/stable/dead transitions', () => {
    it('a character reduced to exactly 0 begins dying with a clean slate', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 6 }), { hpDelta: -6 });
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('dying');
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathSaveFailures).toBe(0);
    });

    it('taking damage while already at 0 is an automatic death-save failure', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying' }), { hpDelta: -3 });
      expect(r.deathState).toBe('dying');
      expect(r.deathSaveFailures).toBe(1);
    });

    it('three recorded failures = dead', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying', deathSaveFailures: 2 }), { deathSaveFailures: 3 });
      expect(r.deathState).toBe('dead');
    });

    it('three recorded successes = stable', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 2 }), { deathSaveSuccesses: 3 });
      expect(r.deathState).toBe('stable');
    });

    it('a stable creature that takes damage drops back to dying with a failure', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'stable', deathSaveSuccesses: 3 }), { hpDelta: -2 });
      expect(r.deathState).toBe('dying');
      expect(r.deathSaveFailures).toBe(1);
    });

    it('healing any amount revives a dying character and clears the death-save slate', () => {
      const r = applyCombatantHp(
        charState({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 1, deathSaveFailures: 2 }),
        { hpDelta: 4 },
      );
      expect(r.hpCurrent).toBe(4);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathSaveFailures).toBe(0);
    });
  });

  describe('death-save roll — 5e crit/fumble (issue #619)', () => {
    it('a natural 1 counts as TWO failures', () => {
      // A dying character rolls nat 1 on a death save -> two failure pips at once.
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying' }), { deathSaveRoll: 1 });
      expect(r.hpCurrent).toBe(0);
      expect(r.deathSaveFailures).toBe(2);
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathState).toBe('dying');
    });

    it('a natural 1 from one existing failure kills the character (2 + 1 = 3 fails)', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying', deathSaveFailures: 1 }), { deathSaveRoll: 1 });
      expect(r.deathSaveFailures).toBe(3);
      expect(r.deathState).toBe('dead');
    });

    it('a natural 20 revives the character at 1 HP and clears the death-save slate', () => {
      // A dying character with two failures already banked rolls nat 20 -> 1 HP, none, clear.
      const r = applyCombatantHp(
        charState({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 1, deathSaveFailures: 2 }),
        { deathSaveRoll: 20 },
      );
      expect(r.hpCurrent).toBe(1);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathSaveFailures).toBe(0);
    });

    it('a nat 20 revival does not exceed hpMax (a 1-max character still revives at 1)', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, hpMax: 1, deathState: 'dying' }), { deathSaveRoll: 20 });
      expect(r.hpCurrent).toBe(1);
      expect(r.deathState).toBe('none');
    });

    it('a 10–19 roll adds one success (and stabilizes at three)', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying', deathSaveSuccesses: 2 }), { deathSaveRoll: 14 });
      expect(r.deathSaveSuccesses).toBe(3);
      expect(r.deathState).toBe('stable');
      expect(r.hpCurrent).toBe(0);
    });

    it('a 2–9 roll adds one failure', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying' }), { deathSaveRoll: 7 });
      expect(r.deathSaveFailures).toBe(1);
      expect(r.deathState).toBe('dying');
    });

    it('a death-save roll on a stable character with three banked successes stays stable (the failure adds a pip but the 3 successes hold)', () => {
      // 5e: a stable creature that takes DAMAGE resumes dying (handled by the damagedWhileDown
      // path), but a voluntarily rolled death save merely adds to the slate — three banked
      // successes keep it stable until a failure count catches up.
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'stable', deathSaveSuccesses: 3 }), { deathSaveRoll: 5 });
      expect(r.deathSaveFailures).toBe(1);
      expect(r.deathSaveSuccesses).toBe(3);
      expect(r.deathState).toBe('stable');
    });

    it('a death-save roll on an already-dead character is a no-op', () => {
      // Dead stays dead — the roll can't revive via the normal outcome path.
      const r = applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dead', deathSaveFailures: 3 }), { deathSaveRoll: 20 });
      expect(r.deathState).toBe('dead');
      expect(r.hpCurrent).toBe(0);
      expect(r.deathSaveFailures).toBe(3);
    });

    it('a death-save roll is ignored for monsters (no death-save subsystem)', () => {
      const r = applyCombatantHp(charState({ kind: 'monster', hpCurrent: 0 }), { deathSaveRoll: 20 });
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathSaveFailures).toBe(0);
    });

    it('a death-save roll on a character above 0 HP has no effect (already conscious)', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 10 }), { deathSaveRoll: 1 });
      expect(r.hpCurrent).toBe(10);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveFailures).toBe(0);
    });
  });

  describe('overkill / massive-damage instant death', () => {
    it('a single hit whose overflow past 0 >= hpMax kills a character outright', () => {
      // 20/20 character, 45 damage: 25 overflow >= 20 hpMax -> instant death.
      const r = applyCombatantHp(charState({ hpCurrent: 20, hpMax: 20 }), { hpDelta: -45 });
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('dead');
    });

    it('overflow below hpMax merely downs the character (dying, not dead)', () => {
      // 20/20 character, 30 damage: 10 overflow < 20 hpMax -> dying.
      const r = applyCombatantHp(charState({ hpCurrent: 20, hpMax: 20 }), { hpDelta: -30 });
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('dying');
    });

    it('temp HP counts first, so it can save a character from instant death', () => {
      // 20/20 with 10 temp, 45 damage: 10 soaked, 35 to real HP, overflow 15 < 20 -> dying.
      const r = applyCombatantHp(charState({ hpCurrent: 20, hpMax: 20, hpTemp: 10 }), { hpDelta: -45 });
      expect(r.hpCurrent).toBe(0);
      expect(r.hpTemp).toBe(0);
      expect(r.deathState).toBe('dying');
    });
  });

  describe('monsters never track death saves', () => {
    it('a monster at 0 HP stays deathState none (goes "down", not dying)', () => {
      const r = applyCombatantHp(charState({ kind: 'monster', hpCurrent: 5 }), { hpDelta: -999 });
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathSaveFailures).toBe(0);
    });
  });

  describe('clamping', () => {
    it('healing never exceeds hpMax', () => {
      expect(applyCombatantHp(charState({ hpCurrent: 18 }), { hpDelta: 100 }).hpCurrent).toBe(20);
    });
    it('hpSet is clamped to [0, hpMax]', () => {
      expect(applyCombatantHp(charState(), { hpSet: 999 }).hpCurrent).toBe(20);
      expect(applyCombatantHp(charState(), { hpSet: 0 }).deathState).toBe('dying');
    });
  });

  describe('adapter HP/death model (issue #1503)', () => {
    it('defaults to the 5e model when no adapter model is passed (pre-#1503 behaviour)', () => {
      // No hpModel argument -> DND5E_HP_MODEL -> a 5e character reduced to 0 begins dying.
      const r = applyCombatantHp(charState({ hpCurrent: 6 }), { hpDelta: -6 });
      expect(r.deathState).toBe('dying');
    });

    it('a system without 5e death saves does NOT begin dying at 0 HP', () => {
      // A Starforged / Open Legend / OSR character reduced to 0 is simply "down".
      const r = applyCombatantHp(charState({ hpCurrent: 6 }), { hpDelta: -6 }, NEUTRAL_HP_MODEL);
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveSuccesses).toBe(0);
      expect(r.deathSaveFailures).toBe(0);
    });

    it('taking damage while already at 0 accrues NO failure without death saves', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0 }), { hpDelta: -3 }, NEUTRAL_HP_MODEL);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveFailures).toBe(0);
    });

    it('massive-damage instant death does not apply without death saves', () => {
      // 45 damage to a 20/20 character is instant death under 5e; without 5e death saves the
      // character just drops to 0 ("down") — the table's rules, not 5e's.
      const r = applyCombatantHp(charState({ hpCurrent: 20, hpMax: 20 }), { hpDelta: -45 }, NEUTRAL_HP_MODEL);
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('none');
    });

    it('death-save counter patches on a non-5e combatant only ever decrease (never introduce state)', () => {
      // #1503 (Devin review #1812): a non-death-save system never gains 5e state. An increase is
      // capped at the current value (a no-op on a 0 baseline); a decrease/clear of leftover
      // counters lands so the combatant path matches the sheet.
      // From a 0 baseline, ANY value stays 0 (no new state introduced).
      const r = applyCombatantHp(
        charState({ hpCurrent: 0 }),
        { deathSaveFailures: 3, deathSaveSuccesses: 2 },
        NEUTRAL_HP_MODEL,
      );
      expect(r.deathState).toBe('none');
      expect(r.deathSaveFailures).toBe(0);
      expect(r.deathSaveSuccesses).toBe(0);
      // Leftover counters (a campaign switched off 5e) CAN be cleared — a decrease lands.
      const cleared = applyCombatantHp(
        charState({ hpCurrent: 0, deathSaveFailures: 3, deathSaveSuccesses: 1 }),
        { deathSaveFailures: 0 },
        NEUTRAL_HP_MODEL,
      );
      expect(cleared.deathSaveFailures).toBe(0);
      expect(cleared.deathSaveSuccesses).toBe(1); // untouched (not in the patch)
      // A partial decrease lands; an increase is capped at the current value.
      expect(applyCombatantHp(charState({ hpCurrent: 0, deathSaveFailures: 3 }), { deathSaveFailures: 1 }, NEUTRAL_HP_MODEL).deathSaveFailures).toBe(1);
      expect(applyCombatantHp(charState({ hpCurrent: 0, deathSaveFailures: 1 }), { deathSaveFailures: 5 }, NEUTRAL_HP_MODEL).deathSaveFailures).toBe(1);
    });

    it('a rolled death save has no effect without death saves', () => {
      const r = applyCombatantHp(charState({ hpCurrent: 0 }), { deathSaveRoll: 1 }, NEUTRAL_HP_MODEL);
      expect(r.hpCurrent).toBe(0);
      expect(r.deathState).toBe('none');
      expect(r.deathSaveFailures).toBe(0);
    });

    it('temp HP still absorbs damage first in a system without death saves', () => {
      // Temp-HP-absorbs-first is a universal damage rule, NOT a 5e death rule, so it is NOT
      // gated on the adapter's death model.
      const r = applyCombatantHp(charState({ hpTemp: 5 }), { hpDelta: -8 }, NEUTRAL_HP_MODEL);
      expect(r.hpTemp).toBe(0);
      expect(r.hpCurrent).toBe(17);
    });

    it('concentration checks still fire for a non-5e concentrating character', () => {
      const r = applyCombatantHp(charState({ isConcentrating: true }), { hpDelta: -8 }, NEUTRAL_HP_MODEL);
      expect(r.concentrationCheck).toEqual({ damage: 8, dc: 10 });
    });

    it('preserves deathState at 0 HP but revives when healed above 0 (without 5e death saves)', () => {
      // #1503 review: a non-5e character the table already declared dead/dying is NOT resurrected
      // by an HP tweak that leaves them at 0 HP — the no-death-saves branch preserves the incoming
      // state at 0 HP. But regaining HP DOES revive (mirrors the 5e `hpCurrent > 0` clause and the
      // monster path), so a healed character stops being "down". (Starfinder computes its own
      // dying/dead; a DM may flag dead.)
      const dead = charState({ hpCurrent: 0, deathState: 'dead' });
      const dying = charState({ hpCurrent: 0, deathState: 'dying' });
      // At 0 HP: a non-healing tweak (temp HP) keeps the system/DM-owned state intact.
      expect(applyCombatantHp({ ...dead }, { hpTemp: 5 }, NEUTRAL_HP_MODEL).deathState).toBe('dead');
      // At 0 HP: further damage keeps the state intact.
      expect(applyCombatantHp({ ...dead }, { hpDelta: -3 }, NEUTRAL_HP_MODEL).deathState).toBe('dead');
      expect(applyCombatantHp({ ...dead }, { hpDelta: -3 }, NEUTRAL_HP_MODEL).deathSaveFailures).toBe(0);
      // Healing above 0 HP revives a dying character and clears the slate (review of #1503).
      const revived = applyCombatantHp({ ...dying }, { hpDelta: 5 }, NEUTRAL_HP_MODEL);
      expect(revived.hpCurrent).toBe(5);
      expect(revived.deathState).toBe('none');
      expect(revived.deathSaveSuccesses).toBe(0);
      expect(revived.deathSaveFailures).toBe(0);
      // Healing a system/DM-flagged dead character above 0 HP also revives (5e/monster parity).
      expect(applyCombatantHp({ ...dead }, { hpDelta: 10 }, NEUTRAL_HP_MODEL).deathState).toBe('none');
    });

    it('a system with its own dying model (Starfinder) flags dying at 0 HP via hpSet, matching the damage path', () => {
      // #1503 (Devin review #1812): a Starfinder combatant set straight to 0 HP (hpSet) must reach
      // the same 'dying' state as one damaged to 0 (hpDelta) — its damage path computes dying via
      // applyStarfinderDamage; applyCombatantHp agrees via hpModel.dyingAtZeroHp on the absolute-set
      // path, so the two routes no longer diverge.
      const starfinder = { massiveDamageInstantDeath: false, deathSaves: false, dyingAtZeroHp: true };
      // Absolute-set path: setting HP straight to 0 -> 'dying' (NOT 'none').
      const fromSet = applyCombatantHp(charState({ hpCurrent: 6 }), { hpSet: 0 }, starfinder);
      expect(fromSet.hpCurrent).toBe(0);
      expect(fromSet.deathState).toBe('dying');
      // No 5e death-save counters are written for a system without death saves.
      expect(fromSet.deathSaveSuccesses).toBe(0);
      expect(fromSet.deathSaveFailures).toBe(0);
      // Damage path (applyCombatantHp's own view) reaches the same 'dying' state.
      const fromDelta = applyCombatantHp(charState({ hpCurrent: 6 }), { hpDelta: -6 }, starfinder);
      expect(fromDelta.deathState).toBe('dying');
      // A system/DM-flagged state is still preserved at 0 HP (not overridden to 'dying').
      expect(applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dead' }), { hpSet: 0 }, starfinder).deathState).toBe('dead');
      // Healing above 0 still revives.
      expect(applyCombatantHp(charState({ hpCurrent: 0, deathState: 'dying' }), { hpSet: 5 }, starfinder).deathState).toBe('none');
    });

    it('an unrelated HP edit does not silently flip an already-down Starfinder combatant to dying (#1503)', () => {
      // updateCombatant sets recomputeHp for ANY HP-adjacent field (temp HP, a lowered hpMax, a
      // leftover-counter clear), so applyCombatantHp runs even when HP did not change. Before the
      // gate, a Starfinder combatant sitting at 0 HP with deathState 'none' was silently rewritten
      // to 'dying' by such a bookkeeping patch — and the 'condition' combat-log event only fires
      // for an explicit patch.deathState, so the transition was invisible (Devin review #1812).
      // The dyingAtZeroHp flag now fires only when THIS patch actually produced the zero.
      const starfinder = { massiveDamageInstantDeath: false, deathSaves: false, dyingAtZeroHp: true };
      const down = charState({ hpCurrent: 0, deathState: 'none' });
      // Unrelated edits leave an already-down combatant's deathState untouched.
      expect(applyCombatantHp({ ...down }, { hpTemp: 5 }, starfinder).deathState).toBe('none');
      expect(applyCombatantHp({ ...down }, { deathSaveFailures: 0 }, starfinder).deathState).toBe('none');
      // Further damage at 0 (a negative hpDelta) IS a real damage event -> still 'dying'.
      expect(applyCombatantHp({ ...down }, { hpDelta: -3 }, starfinder).deathState).toBe('dying');
      // An explicit absolute-set to 0 IS the drop that produced the zero -> 'dying'.
      expect(applyCombatantHp(charState({ hpCurrent: 6, deathState: 'none' }), { hpSet: 0 }, starfinder).deathState).toBe('dying');
      // A genuine damage drop to 0 from a healthy state still reaches 'dying'.
      expect(applyCombatantHp(charState({ hpCurrent: 6, deathState: 'none' }), { hpDelta: -6 }, starfinder).deathState).toBe('dying');
    });

    // The server-side parity check the issue asked for: for EVERY registered adapter, a
    // character reduced to 0 HP is "dying" only when the adapter declares 5e death saves, and
    // never accumulates death-save state otherwise. This is the test that proves the death model
    // the adapter declares is the one applyCombatantHp honours server-side.
    const adaptersForHpParity = listRuleSystemAdapters();
    it.each(adaptersForHpParity.map((a) => a.id))(
      'adapter %s at 0 HP: dying when the adapter declares death saves OR its own dying model',
      (id) => {
        const adapter = adaptersForHpParity.find((a) => a.id === id)!;
        const model = hpModelForAdapter(adapter);
        const expected = hasDeathSavesForAdapter(adapter) || model.dyingAtZeroHp ? 'dying' : 'none';
        const r = applyCombatantHp(charState({ hpCurrent: 6 }), { hpDelta: -6 }, model);
        expect(r.deathState).toBe(expected);
        expect(r.deathSaveSuccesses).toBe(0);
        expect(r.deathSaveFailures).toBe(0);
        // The resolution-layer flag agrees with the UI capability for every shipped adapter.
        expect(model.deathSaves).toBe(hasDeathSavesForAdapter(adapter));
      },
    );

    it('the two death-rule authorities agree on a missing adapter too (null → 5e default, #1503)', () => {
      // ruleSystemAdapter() always returns a resolved adapter (5e fallback), so hpModelForAdapter
      // never sees null in production — but its signature accepts null, and hasDeathSavesForAdapter
      // answers `true` for null (a homebrew/unknown campaign shows the 5e tracker). The two must
      // agree at that boundary so a future caller can't get divergent death handling
      // (Devin review #1812).
      expect(hpModelForAdapter(null).deathSaves).toBe(hasDeathSavesForAdapter(null));
      expect(hpModelForAdapter(undefined).deathSaves).toBe(hasDeathSavesForAdapter(undefined));
      expect(hpModelForAdapter(null)).toBe(DND5E_HP_MODEL);
    });
  });
});

/**
 * 5e difficulty / XP-budget estimation (issue #58) — pure table math, unit-tested here.
 */
describe('encounter difficulty (issue #58)', () => {
  describe('parseCr', () => {
    it('accepts numbers and fraction strings', () => {
      expect(parseCr(5)).toBe(5);
      expect(parseCr(0.25)).toBe(0.25);
      expect(parseCr('1/4')).toBe(0.25);
      expect(parseCr('1/8')).toBe(0.125);
      expect(parseCr('10')).toBe(10);
    });
    it('parses OSR N+M and N-M hit dice expressions', () => {
      expect(parseCr('1+1')).toBe(2);
      expect(parseCr('1-1')).toBe(0);
      expect(parseCr('4+1')).toBe(5);
      expect(parseCr('1+1*')).toBe(2);
      expect(parseCr('2*')).toBe(2);
    });
    it('returns null for missing / unparseable CR', () => {
      expect(parseCr(null)).toBeNull();
      expect(parseCr(undefined)).toBeNull();
      expect(parseCr('')).toBeNull();
      expect(parseCr('unknown')).toBeNull();
      expect(parseCr('1/0')).toBeNull();
    });
  });

  describe('crToXp', () => {
    it('maps standard CRs to the DMG XP table', () => {
      expect(crToXp(0)).toBe(10);
      expect(crToXp(0.25)).toBe(50);
      expect(crToXp(1)).toBe(200);
      expect(crToXp(5)).toBe(1800);
      expect(crToXp(10)).toBe(5900);
      expect(crToXp(30)).toBe(155000);
    });
    it('null CR contributes 0 XP', () => {
      expect(crToXp(null)).toBe(0);
    });
  });

  describe('encounterMultiplier', () => {
    it('follows the 5e number-of-monsters brackets', () => {
      expect(encounterMultiplier(1)).toBe(1);
      expect(encounterMultiplier(2)).toBe(1.5);
      expect(encounterMultiplier(3)).toBe(2);
      expect(encounterMultiplier(6)).toBe(2);
      expect(encounterMultiplier(7)).toBe(2.5);
      expect(encounterMultiplier(11)).toBe(3);
      expect(encounterMultiplier(15)).toBe(4);
    });
  });

  describe('xpThresholdsForLevel', () => {
    it('returns the per-level thresholds and clamps to 1..20', () => {
      expect(xpThresholdsForLevel(5)).toEqual({ easy: 250, medium: 500, hard: 750, deadly: 1100 });
      expect(xpThresholdsForLevel(1)).toEqual({ easy: 25, medium: 50, hard: 75, deadly: 100 });
      expect(xpThresholdsForLevel(99)).toEqual(xpThresholdsForLevel(20));
    });
  });

  describe('computeEncounterDifficulty', () => {
    it('bands a CR-10 solo vs four level-5 PCs as deadly', () => {
      const d = computeEncounterDifficulty([5, 5, 5, 5], [10]);
      expect(d.status).toBe('ok');
      expect(d.label).toBe('Deadly');
      expect(d.thresholds).toEqual({ easy: 1000, medium: 2000, hard: 3000, deadly: 4400 });
      expect(d.totalMonsterXp).toBe(5900);
      expect(d.multiplier).toBe(1);
      expect(d.adjustedXp).toBe(5900);
      expect(d.band).toBe('deadly');
      expect(d.assumptions.length).toBeGreaterThan(0);
    });
    it('applies the multiplier for several monsters (3 x CR2 vs 4 L5 = medium)', () => {
      const d = computeEncounterDifficulty([5, 5, 5, 5], [2, 2, 2]);
      expect(d.status).toBe('ok');
      expect(d.totalMonsterXp).toBe(1350); // 3 * 450
      expect(d.multiplier).toBe(2); // 3–6 monsters
      expect(d.adjustedXp).toBe(2700);
      expect(d.band).toBe('medium'); // >= medium 2000, < hard 3000
      expect(d.warnings.some((w) => /action economy/i.test(w))).toBe(true);
    });
    it('a lone weak monster is trivial (below the easy threshold)', () => {
      const d = computeEncounterDifficulty([5, 5, 5, 5], [0.25]);
      expect(d.status).toBe('ok');
      expect(d.adjustedXp).toBe(50);
      expect(d.band).toBe('trivial');
      expect(d.label).toBe('Trivial');
    });
    it('no party -> trivial with zeroed thresholds and a party-data warning', () => {
      const d = computeEncounterDifficulty([], [5]);
      expect(d.thresholds).toEqual({ easy: 0, medium: 0, hard: 0, deadly: 0 });
      expect(d.status).toBe('ok');
      expect(d.band).toBe('trivial');
      expect(d.warnings.some((w) => /No PC levels/i.test(w))).toBe(true);
    });
    it('no monsters -> trivial', () => {
      const d = computeEncounterDifficulty([5, 5], []);
      expect(d.monsterCount).toBe(0);
      expect(d.adjustedXp).toBe(0);
      expect(d.status).toBe('ok');
      expect(d.band).toBe('trivial');
    });
    it('manual enemies with no CR/XP are unknown — never Trivial (issue #429)', () => {
      const d = computeEncounterDifficulty([5, 5, 5, 5], [null, null]);
      expect(d.status).toBe('unknown');
      expect(d.band).toBeNull();
      expect(d.label).toBe('Unknown—add XP/CR');
      expect(d.adjustedXp).toBe(0);
      expect(d.monstersMissingRating).toBe(2);
      expect(d.warnings.some((w) => /no CR\/XP/i.test(w))).toBe(true);
    });
  });
});

describe('encounter generator (issue #304)', () => {
  /** Candidate factory — XP defaults to the 5e CR→XP table so tests read in CR terms. */
  function cand(over: Partial<GeneratorCandidate> & { ruleEntryId: number; cr: number }): GeneratorCandidate {
    return { name: `m${over.ruleEntryId}`, xp: crToXp(over.cr), hpMax: 10, ...over };
  }

  describe('mulberry32', () => {
    it('is deterministic: the same seed yields the same sequence', () => {
      const a = mulberry32(42);
      const b = mulberry32(42);
      const seqA = [a(), a(), a()];
      const seqB = [b(), b(), b()];
      expect(seqA).toEqual(seqB);
      expect(seqA[0]).toBeGreaterThanOrEqual(0);
      expect(seqA[0]).toBeLessThan(1);
    });
    it('different seeds diverge', () => {
      expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    });
  });

  describe('generateEncounterGroup', () => {
    const party = [5, 5, 5, 5]; // thresholds easy 1000 / medium 2000 / hard 3000 / deadly 4400

    it('hits the target band using compendium monsters (medium via CR2 goblins)', () => {
      const candidates = [cand({ ruleEntryId: 1, cr: 2 })]; // xp 450
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: 7 });
      expect(r.matchedBand).toBe(true);
      expect(r.difficulty.band).toBe('medium');
      expect(r.picks).toHaveLength(1);
      // 3 x CR2 = 1350 * x2 multiplier = 2700 -> medium (>=2000, <3000).
      expect(r.picks[0].count).toBe(3);
      expect(r.picks[0].ruleEntryId).toBe(1);
      expect(r.difficulty.adjustedXp).toBe(2700);
    });

    it('is reproducible by seed and re-rolls with a different seed', () => {
      const candidates = [cand({ ruleEntryId: 1, cr: 1 }), cand({ ruleEntryId: 2, cr: 2 }), cand({ ruleEntryId: 3, cr: 3 })];
      const a = generateEncounterGroup({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: 12345 });
      const b = generateEncounterGroup({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: 12345 });
      expect(b.picks).toEqual(a.picks);
      expect(b.difficulty.band).toBe(a.difficulty.band);
      // Every exact-band result is genuinely on-band.
      if (a.matchedBand) expect(a.difficulty.band).toBe('hard');
    });

    it('respects shape=solo (a single monster)', () => {
      const candidates = [cand({ ruleEntryId: 1, cr: 2 }), cand({ ruleEntryId: 2, cr: 10 })]; // CR10 xp 5900 -> deadly solo
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'deadly', candidates, shape: 'solo', maxCount: 12, seed: 3 });
      expect(r.picks).toHaveLength(1);
      expect(r.picks[0].count).toBe(1);
      expect(r.shape).toBe('solo');
      expect(r.matchedBand).toBe(true);
      expect(r.difficulty.band).toBe('deadly');
    });

    it('respects shape=horde count window (7+)', () => {
      const candidates = [cand({ ruleEntryId: 1, cr: 0.25 })]; // weak mob
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'deadly', candidates, shape: 'horde', maxCount: 12, seed: 9 });
      expect(r.picks[0].count).toBeGreaterThanOrEqual(7);
      expect(r.picks[0].count).toBeLessThanOrEqual(12);
      expect(r.shape).toBe('horde');
    });

    it('budgets hazards like monsters and carries entryType through to the pick (issue #404)', () => {
      // A hazard is a first-class budget building block: it competes in the same CR/XP search
      // and its entryType survives onto the returned pick so the caller can add it as a hazard.
      const candidates = [cand({ ruleEntryId: 7, cr: 2, name: 'Spiked Pit', entryType: 'hazard' })];
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: 7 });
      expect(r.matchedBand).toBe(true);
      expect(r.difficulty.band).toBe('medium');
      expect(r.picks).toHaveLength(1);
      expect(r.picks[0].ruleEntryId).toBe(7);
      expect(r.picks[0].entryType).toBe('hazard');
    });

    it('empty candidate list yields an empty group (no monsters to pick)', () => {
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'medium', candidates: [], maxCount: 12, seed: 1 });
      expect(r.picks).toHaveLength(0);
      expect(r.matchedBand).toBe(false); // medium is unachievable with nothing
      expect(r.difficulty.band).toBe('trivial');
    });

    it('best-effort when the band is unachievable (only a weak monster, target deadly, solo)', () => {
      const candidates = [cand({ ruleEntryId: 1, cr: 0.25 })]; // xp 50, can never reach deadly solo
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'deadly', candidates, shape: 'solo', maxCount: 12, seed: 5 });
      expect(r.matchedBand).toBe(false);
      expect(r.picks).toHaveLength(1); // returns the closest group rather than nothing
      expect(r.difficulty.band).not.toBe('deadly');
    });

    it('candidates with 0 XP (unparseable CR) are skipped', () => {
      const candidates = [cand({ ruleEntryId: 1, cr: 2, xp: 0 })];
      const r = generateEncounterGroup({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: 2 });
      expect(r.picks).toHaveLength(0);
    });
  });
});

describe('encounters — redactEncounterEventsForViewer (issue #869)', () => {
  function ev(over: Partial<EncounterEvent> & { id: number; type: EncounterEvent['type'] }): EncounterEvent {
    return {
      encounterId: 1,
      round: 1,
      actor: null,
      target: null,
      actorId: null,
      targetId: null,
      detail: '',
      chainId: null,
      parentEventId: null,
      phase: null,
      performedBy: null,
      metadata: {},
      createdAt: '2026-07-23T00:00:00.000Z',
      ...over,
    };
  }

  const traitor = { id: 10, name: 'The Traitor', npcId: 99 };
  const aria = { id: 11, name: 'Aria', npcId: null };
  const combatants = [traitor, aria];

  it('masks actor/target by combatant id when the linked NPC is currently hidden', () => {
    const events = [
      ev({ id: 1, type: 'damage', actor: 'Aria', actorId: 11, target: 'The Traitor', targetId: 10, detail: 'took 8 damage' }),
      ev({ id: 2, type: 'turn', actor: 'The Traitor', actorId: 10, target: 'The Traitor', targetId: 10, detail: '' }),
      ev({ id: 3, type: 'condition', target: 'The Traitor', targetId: 10, detail: 'gained Poisoned' }),
      ev({ id: 4, type: 'heal', target: 'The Traitor', targetId: 10, detail: 'healed 3 HP' }),
      ev({ id: 5, type: 'death', target: 'The Traitor', targetId: 10, detail: 'dropped to 0 HP' }),
      ev({ id: 6, type: 'roll', target: 'The Traitor', targetId: 10, detail: 'death save d20 1 — marked a death save' }),
    ];
    const redacted = redactEncounterEventsForViewer(events, combatants, new Set([99]));
    for (const e of redacted) {
      expect(JSON.stringify(e)).not.toMatch(/Traitor/);
      if (e.targetId === 10) expect(e.target).toBe(UNKNOWN_COMBATANT_LABEL);
      if (e.actorId === 10) expect(e.actor).toBe(UNKNOWN_COMBATANT_LABEL);
    }
    // Stable ids survive projection so clients can correlate with the roster token.
    expect(redacted[0].targetId).toBe(10);
    expect(redacted[0].actor).toBe('Aria');
    expect(redacted[0].detail).toBe('took 8 damage');
  });

  it('masks an unlinked duplicate by its internal NPC identity source', () => {
    const duplicate = { id: 12, name: 'The Traitor 2', npcId: null, npcIdentitySourceId: 99 };
    const [redacted] = redactEncounterEventsForViewer(
      [ev({ id: 1, type: 'damage', target: duplicate.name, targetId: duplicate.id, detail: `${duplicate.name} took 8 damage` })],
      [duplicate],
      new Set([99]),
    );
    expect(JSON.stringify(redacted)).not.toMatch(/Traitor/);
    expect(redacted.target).toBe(UNKNOWN_COMBATANT_LABEL);
  });

  it('scrubs name-bearing detail prose (legacy turn lines) when the NPC is hidden', () => {
    const events = [
      ev({
        id: 1,
        type: 'turn',
        actor: 'The Traitor',
        actorId: 10,
        target: 'The Traitor',
        targetId: 10,
        detail: "Combat started — The Traitor's turn (round 1)",
      }),
    ];
    const [redacted] = redactEncounterEventsForViewer(events, combatants, new Set([99]));
    expect(redacted.detail).not.toMatch(/Traitor/);
    expect(redacted.detail).toContain(UNKNOWN_COMBATANT_LABEL);
    expect(redacted.actor).toBe(UNKNOWN_COMBATANT_LABEL);
  });

  it('reveals historical names after the NPC is no longer hidden (current projection)', () => {
    const events = [
      ev({ id: 1, type: 'damage', target: 'The Traitor', targetId: 10, detail: 'took 8 damage' }),
    ];
    const whileHidden = redactEncounterEventsForViewer(events, combatants, new Set([99]));
    expect(whileHidden[0].target).toBe(UNKNOWN_COMBATANT_LABEL);

    const afterReveal = redactEncounterEventsForViewer(events, combatants, new Set());
    expect(afterReveal[0].target).toBe('The Traitor');
    expect(afterReveal[0].targetId).toBe(10);
  });

  it('best-effort masks legacy rows that only have denormalized names (no combatant ids)', () => {
    const events = [ev({ id: 1, type: 'damage', target: 'The Traitor', detail: 'took 4 damage' })];
    const [redacted] = redactEncounterEventsForViewer(events, combatants, new Set([99]));
    expect(redacted.target).toBe(UNKNOWN_COMBATANT_LABEL);
    expect(redacted.detail).toBe('took 4 damage');
  });

  it('strips DM-only metadata from hidden NPC ruling events (issue #426)', () => {
    const events = [
      ev({
        id: 1,
        type: 'roll',
        target: 'The Traitor',
        targetId: 10,
        phase: 'ruling',
        detail: 'hit',
        metadata: { playerText: 'The Traitor was hit', dmText: 'The Traitor AC 14 vs 18' },
      }),
    ];
    const [redacted] = redactEncounterEventsForViewer(events, combatants, new Set([99]));
    expect(redacted.metadata?.dmText).toBeUndefined();
    expect(redacted.metadata?.playerText).toContain(UNKNOWN_COMBATANT_LABEL);
  });
});

describe('initialEncounterTurnState (issue #1459)', () => {
  it('skips dead/downed combatants at start of initiative', () => {
    const sorted = [
      { id: 1, initiative: 25, deathState: 'dead', kind: 'character' },
      { id: 2, initiative: 20, deathState: 'none', kind: 'monster', hpCurrent: 50 },
      { id: 3, initiative: 15, deathState: 'none', kind: 'character' },
    ] as any;
    
    const result = initialEncounterTurnState(sorted, false);
    
    expect(result.currentCombatantId).toBe(2);
    expect(result.turnIndex).toBe(1);
    expect(result.phase).toBe('combatant');
  });
  
  it('skips all if all are dead', () => {
    const sorted = [
      { id: 1, initiative: 25, deathState: 'dead', kind: 'character' },
    ] as any;
    
    const result = initialEncounterTurnState(sorted, false);
    
    expect(result.currentCombatantId).toBe(null);
    expect(result.turnIndex).toBe(0);
    expect(result.phase).toBe('combatant');
  });
});

describe('rollRechargeAtTurnStart / undoActionUsesRecharge (issue #1921)', () => {
  it('rolls only spent entries, recharges on a hit, and records a delta for undo', () => {
    const uses = { 'statblock:abc': { spent: 1 } };
    const rolls = [6, 5]; // ignored: 6 (>= needs 5) recovers first call
    let i = 0;
    const roll = () => rolls[i++];
    const result = rollRechargeAtTurnStart(uses, [{ key: 'statblock:abc', name: 'Breath Weapon', min: 5, max: 1 }], roll);
    expect(result.rolls).toEqual([{ key: 'statblock:abc', actionName: 'Breath Weapon', roll: 6, needs: 5, recovered: true }]);
    expect(result.uses['statblock:abc']).toEqual({ spent: 0 });
    expect(result.delta).toEqual([{ key: 'statblock:abc', actionName: 'Breath Weapon', max: 1 }]);
  });

  it('leaves an action spent on a miss, with no undo delta', () => {
    const uses = { 'statblock:abc': { spent: 1 } };
    const roll = () => 3; // below needs 5
    const result = rollRechargeAtTurnStart(uses, [{ key: 'statblock:abc', name: 'Breath Weapon', min: 5, max: 1 }], roll);
    expect(result.rolls).toEqual([{ key: 'statblock:abc', actionName: 'Breath Weapon', roll: 3, needs: 5, recovered: false }]);
    expect(result.uses['statblock:abc']).toEqual({ spent: 1 });
    expect(result.delta).toEqual([]);
  });

  it('never rolls an entry that has not been spent (nothing to recharge)', () => {
    const uses = {};
    const roll = jest.fn(() => 6);
    const result = rollRechargeAtTurnStart(uses, [{ key: 'statblock:abc', name: 'Breath Weapon', min: 5, max: 1 }], roll);
    expect(roll).not.toHaveBeenCalled();
    expect(result.rolls).toEqual([]);
    expect(result.delta).toEqual([]);
  });

  it('rolls multiple spent recharge actions independently in one tick', () => {
    const uses = { 'statblock:a': { spent: 1 }, 'statblock:b': { spent: 1 } };
    const rollsQueue = [6, 1]; // a recharges, b does not
    let i = 0;
    const roll = () => rollsQueue[i++];
    const result = rollRechargeAtTurnStart(
      uses,
      [
        { key: 'statblock:a', name: 'Breath Weapon', min: 5, max: 1 },
        { key: 'statblock:b', name: 'Frost Ray', min: 6, max: 1 },
      ],
      roll,
    );
    expect(result.uses).toEqual({ 'statblock:a': { spent: 0 }, 'statblock:b': { spent: 1 } });
    expect(result.delta).toEqual([{ key: 'statblock:a', actionName: 'Breath Weapon', max: 1 }]);
  });

  it('gives back exactly ONE use of a multi-use pool, not the whole pool', () => {
    // `{ max: 3, recharge: 'recharge-5-6' }` is authorable (statblock editor, MCP
    // `update_combatant`) and reaches this tick because `parseRechargeRange` matches. Two of
    // the three uses are spent; one lucky die must return one of them, not both.
    const uses = { 'statblock:abc': { spent: 2 } };
    const result = rollRechargeAtTurnStart(uses, [{ key: 'statblock:abc', name: 'Breath Weapon', min: 5, max: 3 }], () => 6);
    expect(result.uses['statblock:abc']).toEqual({ spent: 1 });
    expect(result.delta).toEqual([{ key: 'statblock:abc', actionName: 'Breath Weapon', max: 3 }]);
    // Undo with nothing in between puts the one use straight back.
    expect(undoActionUsesRecharge(result.uses, result.delta).uses['statblock:abc']).toEqual({ spent: 2 });
  });

  // Devin review on PR #2062, follow-on to the one-use fix above: the undo used to ASSIGN the
  // pre-roll count, which silently swallowed a spend made during the undone turn. On a pool of
  // one the two are indistinguishable (0 and 1 are the only reachable values), which is why
  // every other case here passes against the bug — seeing it at all requires `max: 3`.
  it('undoActionUsesRecharge composes with a spend made during the undone turn', () => {
    const delta = [{ key: 'statblock:abc', actionName: 'Breath Weapon', max: 3 }];
    // Pre-turn spent 2 -> the roll recharges to 1 -> the monster fires it that turn, back to 2.
    // Undoing the turn must reach 3: the pre-turn 2, plus the new use, minus the recharge.
    // Assigning the recorded pre-roll 2 would hand the monster a free extra firing.
    expect(undoActionUsesRecharge({ 'statblock:abc': { spent: 2 } }, delta).uses['statblock:abc']).toEqual({ spent: 3 });
    // And it never runs past the pool ceiling.
    expect(undoActionUsesRecharge({ 'statblock:abc': { spent: 3 } }, delta).uses['statblock:abc']).toEqual({ spent: 3 });
  });

  it('undoActionUsesRecharge restores spent state from the recorded delta', () => {
    const afterRecharge = { 'statblock:abc': { spent: 0 } };
    const { uses, restoredNames } = undoActionUsesRecharge(afterRecharge, [
      { key: 'statblock:abc', actionName: 'Breath Weapon', max: 1 },
    ]);
    expect(uses['statblock:abc']).toEqual({ spent: 1 });
    expect(restoredNames).toEqual(['Breath Weapon']);
  });

  it('undoActionUsesRecharge is a no-op for an empty delta', () => {
    const currentUses = { 'statblock:abc': { spent: 0 } };
    const { uses, restoredNames } = undoActionUsesRecharge(currentUses, []);
    expect(uses).toBe(currentUses);
    expect(restoredNames).toEqual([]);
  });
});
