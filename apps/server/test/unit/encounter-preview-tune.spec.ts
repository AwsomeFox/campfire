import { buildDifficultyExplanation, computeDnd5eEncounterDifficulty, unsupportedEncounterDifficulty, crToXp } from '@campfire/schema';
import {
  buildEncounterRoster,
  deriveEncounterRosterWarnings,
} from '../../src/modules/encounters/encounters.logic';
import type { GeneratorCandidate } from '../../src/modules/encounters/encounters.logic';

/**
 * Unit tests for the interactive preview-and-tune roster math (issue #412). Pure functions,
 * no DB — the exact #58 difficulty math is reused, so the assertions read in CR/XP terms.
 */

/** Candidate factory — XP defaults to the 5e CR→XP table so tests read in CR terms. */
function cand(over: Partial<GeneratorCandidate> & { ruleEntryId: number; cr: number }): GeneratorCandidate {
  return { name: `m${over.ruleEntryId}`, xp: crToXp(over.cr), hpMax: 10, ...over };
}

// Party of four level-5 PCs: thresholds easy 1000 / medium 2000 / hard 3000 / deadly 4400.
const party = [5, 5, 5, 5];

describe('buildEncounterRoster (issue #412)', () => {
  it('freshly generates a single primary slot hitting the target band', () => {
    const candidates = [cand({ ruleEntryId: 1, cr: 2 })]; // xp 450
    const r = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: 7 });
    expect(r.plan).toHaveLength(1);
    expect(r.plan[0].slotId).toBe('s1');
    expect(r.plan[0].ruleEntryId).toBe(1);
    expect(r.plan[0].pinned).toBe(false);
    expect(r.matchedBand).toBe(true);
    expect(r.difficulty.band).toBe('medium');
    // Round-trip: re-running with the returned plan and no tune is a stable no-op.
    const again = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: r.seed, plan: r.plan });
    expect(again.plan).toEqual(r.plan);
  });

  it('reroll-slot is deterministic by seed and changes the pick', () => {
    const candidates = [cand({ ruleEntryId: 1, cr: 1 }), cand({ ruleEntryId: 2, cr: 2 }), cand({ ruleEntryId: 3, cr: 3 })];
    const base = buildEncounterRoster({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: 100 });
    const a = buildEncounterRoster({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: base.seed, plan: base.plan, tune: { op: 'reroll-slot', slotId: 's1', seed: 555 } });
    const b = buildEncounterRoster({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: base.seed, plan: base.plan, tune: { op: 'reroll-slot', slotId: 's1', seed: 555 } });
    expect(a.plan).toEqual(b.plan);
    expect(a.plan[0].seed).toBe(555);
  });

  it('pin protects a slot from reroll-all', () => {
    const candidates = [cand({ ruleEntryId: 1, cr: 2 }), cand({ ruleEntryId: 2, cr: 3 })];
    let r = buildEncounterRoster({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: 5 });
    // Pin the primary slot, then reroll-all — the pinned slot must be preserved verbatim.
    r = buildEncounterRoster({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: r.seed, plan: r.plan, tune: { op: 'pin', slotId: 's1', pinned: true } });
    const pinnedSlot = { ...r.plan[0] };
    const after = buildEncounterRoster({ partyLevels: party, targetBand: 'hard', candidates, maxCount: 12, seed: r.seed, plan: r.plan, tune: { op: 'reroll-all', seed: 999 } });
    const stillThere = after.plan.find((s) => s.slotId === 's1');
    expect(stillThere).toEqual(pinnedSlot);
  });

  it('swap-slot replaces the creature and keeps the slot id', () => {
    const candidates = [cand({ ruleEntryId: 1, cr: 2 }), cand({ ruleEntryId: 2, cr: 3 })];
    const base = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: 3 });
    const swapped = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: base.seed, plan: base.plan, tune: { op: 'swap-slot', slotId: 's1', ruleEntryId: 2 } });
    expect(swapped.plan[0].slotId).toBe('s1');
    expect(swapped.plan[0].ruleEntryId).toBe(2);
    expect(swapped.picks[0].ruleEntryId).toBe(2);
  });

  it('adjust-count clamps and recomputes difficulty', () => {
    const candidates = [cand({ ruleEntryId: 1, cr: 2 })];
    const base = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 12, seed: 7 });
    const adjusted = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates, maxCount: 4, seed: base.seed, plan: base.plan, tune: { op: 'adjust-count', slotId: 's1', count: 10 } });
    // Clamped to maxCount=4.
    expect(adjusted.plan[0].count).toBe(4);
  });

  it('add-slot grows the roster and remove-slot shrinks it', () => {
    const candidates = [cand({ ruleEntryId: 1, cr: 2 }), cand({ ruleEntryId: 2, cr: 1 })];
    const base = buildEncounterRoster({ partyLevels: party, targetBand: 'deadly', candidates, maxCount: 12, seed: 4 });
    const added = buildEncounterRoster({ partyLevels: party, targetBand: 'deadly', candidates, maxCount: 12, seed: base.seed, plan: base.plan, tune: { op: 'add-slot', seed: 22 } });
    expect(added.plan.length).toBe(base.plan.length + 1);
    const removed = buildEncounterRoster({ partyLevels: party, targetBand: 'deadly', candidates, maxCount: 12, seed: added.seed, plan: added.plan, tune: { op: 'remove-slot', slotId: added.plan[added.plan.length - 1].slotId } });
    expect(removed.plan.length).toBe(base.plan.length);
  });

  it('empty candidates produce an empty plan', () => {
    const r = buildEncounterRoster({ partyLevels: party, targetBand: 'medium', candidates: [], maxCount: 12, seed: 1 });
    expect(r.plan).toHaveLength(0);
    expect(r.picks).toHaveLength(0);
  });
});

describe('deriveEncounterRosterWarnings (issue #412)', () => {
  it('flags missing statblocks (no HP/CR)', () => {
    const picks = [{ ruleEntryId: 1, name: 'Blob', entryType: 'monster' as const, cr: null, xp: 0, hpMax: null, count: 1 }];
    const diff = computeDnd5eEncounterDifficulty({ partyLevels: party, monsterChallengeRatings: [null] });
    const w = deriveEncounterRosterWarnings(picks, party, diff, true, 'medium');
    expect(w.some((x) => x.code === 'missing-statblock')).toBe(true);
  });

  it('flags role duplication when the same statblock fills two slots', () => {
    const picks = [
      { ruleEntryId: 1, name: 'Goblin', entryType: 'monster' as const, cr: 2, xp: 450, hpMax: 22, count: 2 },
      { ruleEntryId: 1, name: 'Goblin', entryType: 'monster' as const, cr: 2, xp: 450, hpMax: 22, count: 2 },
    ];
    const diff = computeDnd5eEncounterDifficulty({ partyLevels: party, monsterChallengeRatings: [2, 2, 2, 2] });
    const w = deriveEncounterRosterWarnings(picks, party, diff, true, 'hard');
    expect(w.some((x) => x.code === 'role-duplication')).toBe(true);
  });

  it('flags action-economy for a lone monster against a full party', () => {
    const picks = [{ ruleEntryId: 1, name: 'Ogre', entryType: 'monster' as const, cr: 10, xp: 5900, hpMax: 90, count: 1 }];
    const diff = computeDnd5eEncounterDifficulty({ partyLevels: party, monsterChallengeRatings: [10] });
    const w = deriveEncounterRosterWarnings(picks, party, diff, true, 'deadly');
    expect(w.some((x) => x.code === 'action-economy')).toBe(true);
    // A lone CR10 vs level-5 party is also swingy.
    expect(w.some((x) => x.code === 'swinginess')).toBe(true);
  });

  it('flags unsupported-system math', () => {
    const picks = [{ ruleEntryId: 1, name: 'Thing', entryType: 'monster' as const, cr: 3, xp: 700, hpMax: 40, count: 2 }];
    const diff = unsupportedEncounterDifficulty('Homebrew', { partyLevels: party, monsterChallengeRatings: [3, 3] });
    const w = deriveEncounterRosterWarnings(picks, party, diff, true, 'medium');
    expect(w.some((x) => x.code === 'unsupported-system')).toBe(true);
  });

  it('flags an empty roster', () => {
    const diff = computeDnd5eEncounterDifficulty({ partyLevels: party, monsterChallengeRatings: [] });
    const w = deriveEncounterRosterWarnings([], party, diff, false, 'medium');
    expect(w.some((x) => x.code === 'empty-roster')).toBe(true);
  });
});

describe('buildDifficultyExplanation (issue #412)', () => {
  it('explains an OK band with the threshold comparison + multiplier', () => {
    const diff = computeDnd5eEncounterDifficulty({ partyLevels: party, monsterChallengeRatings: [2, 2, 2] });
    const e = buildDifficultyExplanation(diff);
    expect(e.status).toBe('ok');
    expect(e.band).toBe(diff.band);
    expect(e.headline.length).toBeGreaterThan(0);
    expect(e.detail.some((d) => /multiplier/i.test(d))).toBe(true);
    expect(e.adjustedXp).toBe(diff.adjustedXp);
  });

  it('explains an unsupported system without a fabricated band', () => {
    const diff = unsupportedEncounterDifficulty('Homebrew', { partyLevels: party, monsterChallengeRatings: [3] });
    const e = buildDifficultyExplanation(diff);
    expect(e.status).toBe('unsupported');
    expect(e.band).toBeNull();
    expect(e.headline).toContain('Homebrew');
  });

  it('explains an unknown budget when monsters carry no CR', () => {
    const diff = computeDnd5eEncounterDifficulty({ partyLevels: party, monsterChallengeRatings: [null, null] });
    const e = buildDifficultyExplanation(diff);
    expect(e.status).toBe('unknown');
    expect(e.band).toBeNull();
    expect(e.headline.toLowerCase()).toContain('unknown');
  });
});
