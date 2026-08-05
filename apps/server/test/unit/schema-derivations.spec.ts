import {
  xpForLevel,
  levelForXp,
  XP_THRESHOLDS,
  normalizeStats,
  DiceExprPattern,
  XpAward,
  CombatantRemoveRequest,
  CombatantUpdate,
  CombatantResourceAdjust,
} from '@campfire/schema';

/**
 * Unit tests for the pure derivations in the shared schema package (issue #79):
 * D&D 5e XP<->level tables, ability-stat key normalisation (issue #48), and the
 * dice-expression regex the API DTO and the roller both key off.
 */
describe('schema — XP thresholds', () => {
  it('has 20 cumulative levels, level 1 at 0 XP and level 20 at 355,000', () => {
    expect(XP_THRESHOLDS).toHaveLength(20);
    expect(XP_THRESHOLDS[0]).toBe(0);
    expect(XP_THRESHOLDS[19]).toBe(355000);
  });

  it('is monotonically non-decreasing', () => {
    for (let i = 1; i < XP_THRESHOLDS.length; i++) {
      expect(XP_THRESHOLDS[i]).toBeGreaterThan(XP_THRESHOLDS[i - 1]);
    }
  });

  it('xpForLevel returns the cumulative threshold for a level', () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(300);
    expect(xpForLevel(20)).toBe(355000);
  });

  it('xpForLevel clamps out-of-range levels into [1, 20]', () => {
    expect(xpForLevel(0)).toBe(xpForLevel(1));
    expect(xpForLevel(-5)).toBe(xpForLevel(1));
    expect(xpForLevel(99)).toBe(xpForLevel(20));
  });

  it('xpForLevel floors fractional levels', () => {
    expect(xpForLevel(2.9)).toBe(xpForLevel(2));
  });

  it('levelForXp returns the highest level the XP qualifies for', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(299)).toBe(1);
    expect(levelForXp(300)).toBe(2);
    expect(levelForXp(355000)).toBe(20);
    expect(levelForXp(9_999_999)).toBe(20);
  });

  it('xpForLevel and levelForXp round-trip at each threshold', () => {
    for (let level = 1; level <= 20; level++) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
    }
  });
});

describe('schema — party XP recipients (issue #814)', () => {
  it('defaults the non-active opt-in to false', () => {
    expect(XpAward.parse({ amount: 250, characterIds: [1, 2] })).toEqual({
      amount: 250,
      characterIds: [1, 2],
      includeNonActive: false,
    });
  });

  it('accepts an explicit non-active opt-in for historical corrections', () => {
    expect(XpAward.parse({ amount: 250, characterIds: [3], includeNonActive: true }).includeNonActive).toBe(true);
  });

  it('rejects empty or duplicate recipient selections', () => {
    expect(XpAward.safeParse({ amount: 250, characterIds: [] }).success).toBe(false);
    expect(XpAward.safeParse({ amount: 250, characterIds: [1, 1] }).success).toBe(false);
  });
});

describe('schema — normalizeStats (issue #48)', () => {
  it('uppercases lowercase ability keys', () => {
    expect(normalizeStats({ str: 16, dex: 14 })).toEqual({ STR: 16, DEX: 14 });
  });

  it('returns an empty object for null/undefined', () => {
    expect(normalizeStats(null)).toEqual({});
    expect(normalizeStats(undefined)).toEqual({});
  });

  it('lets an exact-uppercase key win over a lowercase duplicate', () => {
    // Uppercase is authoritative; the lowercase dup must not clobber it.
    expect(normalizeStats({ STR: 18, str: 8 })).toEqual({ STR: 18 });
  });

  it('passes through already-canonical keys unchanged', () => {
    expect(normalizeStats({ STR: 10, CON: 12 })).toEqual({ STR: 10, CON: 12 });
  });
});

describe('schema — DiceExprPattern', () => {
  it.each(['1d20+3', 'd20', '2d6-1', ' 3d8 + 2 ', '1D100'])('matches valid %p', (expr) => {
    expect(DiceExprPattern.test(expr)).toBe(true);
  });

  it.each(['', 'd', '20', '1d', 'notdice', '1d20+'])('rejects invalid %p', (expr) => {
    expect(DiceExprPattern.test(expr)).toBe(false);
  });
});

describe('schema — direct encounter damage metadata (issue #605)', () => {
  it('accepts a trimmed non-empty damage type and rejects blank values', () => {
    expect(CombatantUpdate.parse({ hpDelta: -4, damageType: ' fire ' }).damageType).toBe('fire');
    expect(CombatantUpdate.safeParse({ hpDelta: -4, damageType: '' }).success).toBe(false);
    expect(CombatantUpdate.safeParse({ hpDelta: -4, damageType: '   ' }).success).toBe(false);
  });

  it('requires a positive dice subtotal when critical metadata includes one', () => {
    expect(CombatantUpdate.safeParse({ hpDelta: -4, isCrit: true, damageDice: 4 }).success).toBe(true);
    expect(CombatantUpdate.safeParse({ hpDelta: -4, isCrit: true, damageDice: 0 }).success).toBe(false);
    expect(CombatantUpdate.safeParse({ hpDelta: -4, isCrit: true, damageDice: -1 }).success).toBe(false);
  });
});

describe('schema — combatant removal retries', () => {
  it('keeps the idempotency key optional for parity between REST and MCP', () => {
    expect(CombatantRemoveRequest.parse({})).toEqual({});
  });
});

describe('schema — CombatantResourceAdjust (issue #1909)', () => {
  it('requires exactly one of key or spellLevel — rejects both and neither', () => {
    expect(CombatantResourceAdjust.safeParse({ key: 'kiPoints' }).success).toBe(true);
    expect(CombatantResourceAdjust.safeParse({ spellLevel: 2 }).success).toBe(true);
    expect(CombatantResourceAdjust.safeParse({}).success).toBe(false);
    expect(CombatantResourceAdjust.safeParse({ key: 'kiPoints', spellLevel: 2 }).success).toBe(false);
  });

  it('defaults delta to +1 (one pip click) when omitted', () => {
    expect(CombatantResourceAdjust.parse({ key: 'kiPoints' }).delta).toBe(1);
  });

  it('rejects a delta of 0 — a no-op that would still mint a resource_changed event', () => {
    expect(CombatantResourceAdjust.safeParse({ key: 'kiPoints', delta: 0 }).success).toBe(false);
  });

  it('rejects a non-integer or out-of-range spellLevel', () => {
    expect(CombatantResourceAdjust.safeParse({ spellLevel: 0 }).success).toBe(false);
    expect(CombatantResourceAdjust.safeParse({ spellLevel: 10 }).success).toBe(false);
    expect(CombatantResourceAdjust.safeParse({ spellLevel: 2.5 }).success).toBe(false);
  });

  it('accepts an optional idempotencyKey, reusing the shared #580 convention', () => {
    const parsed = CombatantResourceAdjust.parse({ key: 'kiPoints', delta: -1, idempotencyKey: 'click-123' });
    expect(parsed.idempotencyKey).toBe('click-123');
    expect(CombatantResourceAdjust.parse({ key: 'kiPoints' }).idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown field (.strict())', () => {
    expect(CombatantResourceAdjust.safeParse({ key: 'kiPoints', used: 3 }).success).toBe(false);
  });
});
