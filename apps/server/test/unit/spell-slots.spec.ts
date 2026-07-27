import {
  applySpellSlotDelta,
  describeSpellSlotChange,
  spellSlotsRemaining,
  SPELL_SLOT_MAX_LEVEL,
  SPELL_SLOT_MIN_LEVEL,
  type SpellSlotMap,
} from '@campfire/schema';

/**
 * #1039 — spell-slot expenditure, pure boundary math.
 *
 * The acceptance criterion is "errors when no slots remain", and the reason it needs its own
 * suite is that the previous implementation SILENTLY CLAMPED: casting at a level with
 * `used === max` returned success with an unchanged sheet. Every case here is about the
 * difference between refusing and pretending.
 */

function slots(over: SpellSlotMap = {}): SpellSlotMap {
  return { '1': { max: 4, used: 0 }, '3': { max: 2, used: 2 }, ...over };
}

function ok(result: ReturnType<typeof applySpellSlotDelta>) {
  if (!result.ok) throw new Error(`expected success, got ${result.reason}: ${result.message}`);
  return result;
}

describe('spellSlotsRemaining (#1039)', () => {
  it('reports what is left, and zero for an unconfigured level', () => {
    expect(spellSlotsRemaining(slots(), 1)).toBe(4);
    expect(spellSlotsRemaining(slots(), 3)).toBe(0);
    expect(spellSlotsRemaining(slots(), 9)).toBe(0);
  });

  it('treats a zero-max level as unconfigured rather than as an empty pool', () => {
    expect(spellSlotsRemaining({ '2': { max: 0, used: 0 } }, 2)).toBe(0);
  });

  it('never reports negative remaining even from a corrupt blob', () => {
    // A blob written by an older build (or by hand) could carry used > max.
    expect(spellSlotsRemaining({ '1': { max: 2, used: 5 } }, 1)).toBe(0);
  });
});

describe('spending must FAIL rather than clamp (#1039)', () => {
  it('refuses a spend at an exhausted level', () => {
    const result = applySpellSlotDelta(slots(), 3, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient_slots');
    expect(result.remaining).toBe(0);
    expect(result.max).toBe(2);
  });

  it('refuses a spend LARGER than what remains, without partially applying it', () => {
    // Partially applying (spend what you can) would be the same lie in a smaller form.
    const result = applySpellSlotDelta(slots({ '1': { max: 4, used: 3 } }), 1, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('insufficient_slots');
    expect(result.remaining).toBe(1);
  });

  it('carries `remaining` and `max` so a model can self-correct instead of retrying blindly', () => {
    const result = applySpellSlotDelta(slots(), 3, 1);
    if (result.ok) throw new Error('expected failure');
    expect(result.message).toMatch(/0 of 2 remain/);
    // Names the two ways out, so the caller has somewhere to go.
    expect(result.message).toMatch(/different level|long rest/i);
  });

  it('distinguishes "no slots at this level" from "none remaining"', () => {
    // These call for different responses: one is a sheet that was never configured, the other
    // is a caster who is genuinely out.
    const unconfigured = applySpellSlotDelta(slots(), 7, 1);
    expect(unconfigured.ok).toBe(false);
    if (!unconfigured.ok) expect(unconfigured.reason).toBe('no_slots_at_level');

    const exhausted = applySpellSlotDelta(slots(), 3, 1);
    if (!exhausted.ok) expect(exhausted.reason).toBe('insufficient_slots');
  });

  it('allows spending EXACTLY the last slot', () => {
    // The boundary the guard must not be off-by-one on.
    const result = ok(applySpellSlotDelta(slots({ '1': { max: 4, used: 3 } }), 1, 1));
    expect(result.usedAfter).toBe(4);
    expect(result.remaining).toBe(0);
    expect(result.clamped).toBe(false);
  });
});

describe('restoring clamps rather than failing (#1039)', () => {
  it('clamps an over-restore at zero and says so', () => {
    // Deliberately asymmetric with spending: a restore cannot invent a slot, and used=0 is the
    // state a long rest produces anyway.
    const result = ok(applySpellSlotDelta(slots({ '1': { max: 4, used: 1 } }), 1, -100));
    expect(result.usedAfter).toBe(0);
    expect(result.remaining).toBe(4);
    expect(result.clamped).toBe(true);
  });

  it('restores exactly when it can', () => {
    const result = ok(applySpellSlotDelta(slots({ '1': { max: 4, used: 3 } }), 1, -2));
    expect(result.usedAfter).toBe(1);
    expect(result.clamped).toBe(false);
  });

  it('still refuses a restore at a level with no slots configured', () => {
    // "No such pool" is not a direction question.
    expect(applySpellSlotDelta(slots(), 8, -1).ok).toBe(false);
  });
});

describe('purity and blob handling (#1039)', () => {
  it('never mutates the input blob', () => {
    const input = slots();
    const snapshot = JSON.parse(JSON.stringify(input));
    applySpellSlotDelta(input, 1, 1);
    expect(input).toEqual(snapshot);
  });

  it('returns a FULL replacement blob, preserving other levels untouched', () => {
    const result = ok(applySpellSlotDelta(slots(), 1, 1));
    expect(result.slots['3']).toEqual({ max: 2, used: 2 });
    expect(Object.keys(result.slots).sort()).toEqual(['1', '3']);
  });

  it('normalizes a corrupt used > max before applying the delta', () => {
    const result = ok(applySpellSlotDelta({ '1': { max: 2, used: 5 } }, 1, -1));
    expect(result.usedBefore).toBe(2);
    expect(result.usedAfter).toBe(1);
  });

  it('a zero delta is a no-op that still succeeds', () => {
    const result = ok(applySpellSlotDelta(slots(), 1, 0));
    expect(result.usedAfter).toBe(0);
    expect(describeSpellSlotChange(result)).toMatch(/no change/i);
  });

  it('addresses the documented level range', () => {
    expect(SPELL_SLOT_MIN_LEVEL).toBe(1);
    expect(SPELL_SLOT_MAX_LEVEL).toBe(9);
  });
});

describe('combat-log description (#1039)', () => {
  it('describes a spend with the remaining count, and carries no character name', () => {
    const result = ok(applySpellSlotDelta(slots(), 1, 1));
    const line = describeSpellSlotChange(result);
    expect(line).toBe('spent 1 level 1 spell slot (3/4 remaining)');
    // The combat log redacts names per role and forbids name-bearing detail text (#869), so the
    // name travels in the `actor` field and must never be interpolated here.
    expect(line).not.toMatch(/[A-Z][a-z]+ (spent|restored)/);
  });

  it('pluralises and describes a restore', () => {
    const result = ok(applySpellSlotDelta(slots({ '1': { max: 4, used: 3 } }), 1, -2));
    expect(describeSpellSlotChange(result)).toBe('restored 2 level 1 spell slots (3/4 remaining)');
  });
});
