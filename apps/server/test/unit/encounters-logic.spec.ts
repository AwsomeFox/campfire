import type { Combatant, EncounterEvent, EncounterStatus } from '@campfire/schema';
import { Dnd5eAdapter, Pf2eAdapter } from '@campfire/schema';
import {
  abilityMod,
  sortCombatants,
  turnIndexFor,
  advanceTurn,
  hpBandFor,
  applyCombatantHp,
  parseCr,
  crToXp,
  xpThresholdsForLevel,
  encounterMultiplier,
  computeEncounterDifficulty,
  mulberry32,
  generateEncounterGroup,
  redactEncounterEventsForViewer,
  UNKNOWN_COMBATANT_LABEL,
} from '../../src/modules/encounters/encounters.logic';
import type { GeneratorCandidate } from '../../src/modules/encounters/encounters.logic';
import type { CombatantHpState } from '../../src/modules/encounters/encounters.logic';

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

  it('running: ties break by sortOrder ascending when no adapter tiebreak is supplied', () => {
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
});
