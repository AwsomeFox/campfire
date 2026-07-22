import { BadRequestException } from '@nestjs/common';
import {
  parseDiceExpr,
  parseCompoundDiceExpr,
  rollDice,
  rollInitiative,
} from '../../src/common/dice';

/**
 * Unit tests for the safe dice parser/roller (issue #79). Pure logic, no
 * bootstrap. Randomness is bounded, so we assert on invariants (range, count,
 * total = sum(rolls) + modifier) rather than exact values.
 */
describe('dice — parseDiceExpr', () => {
  it('parses a full NdM+K expression', () => {
    expect(parseDiceExpr('2d6+3')).toEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it('defaults count to 1 when omitted ("d20" === "1d20")', () => {
    expect(parseDiceExpr('d20')).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it('parses a negative modifier', () => {
    expect(parseDiceExpr('2d6-1')).toEqual({ count: 2, sides: 6, modifier: -1 });
  });

  it('tolerates surrounding and in-modifier whitespace', () => {
    expect(parseDiceExpr('  1d20 + 3 ')).toEqual({ count: 1, sides: 20, modifier: 3 });
  });

  it('is case-insensitive on the "d"', () => {
    expect(parseDiceExpr('1D8')).toEqual({ count: 1, sides: 8, modifier: 0 });
  });

  it.each(['', 'abc', '20', 'd', '1d20+', '1d20++3', 'd20 plus 3'])(
    'rejects malformed expression %p',
    (expr) => {
      expect(() => parseDiceExpr(expr)).toThrow(BadRequestException);
    },
  );

  it('rejects a non-polyhedral die (1d7)', () => {
    expect(() => parseDiceExpr('1d7')).toThrow(/sides must be one of/);
  });

  it.each([2, 4, 6, 8, 10, 12, 20, 100])('accepts standard die d%i', (sides) => {
    expect(parseDiceExpr(`1d${sides}`).sides).toBe(sides);
  });

  it('rejects a count above the tabletop cap (21d6)', () => {
    expect(() => parseDiceExpr('21d6')).toThrow(/count must be between 1 and 20/);
  });

  it('rejects a modifier beyond +/-999', () => {
    // 4-digit modifiers exceed the regex shape entirely, so this is a parse error.
    expect(() => parseDiceExpr('1d20+1000')).toThrow(BadRequestException);
  });

  it('parses keep-highest (advantage: 2d20kh1)', () => {
    expect(parseDiceExpr('2d20kh1')).toEqual({ count: 2, sides: 20, modifier: 0, keep: { mode: 'kh', n: 1 } });
  });

  it('parses keep-lowest (disadvantage: 2d20kl1)', () => {
    expect(parseDiceExpr('2d20kl1')).toEqual({ count: 2, sides: 20, modifier: 0, keep: { mode: 'kl', n: 1 } });
  });

  it('parses drop-lowest with a modifier (4d6dl1+2)', () => {
    expect(parseDiceExpr('4d6dl1+2')).toEqual({ count: 4, sides: 6, modifier: 2, keep: { mode: 'dl', n: 1 } });
  });

  it('parses drop-highest (4d6dh1) and keep-highest-3 (4d6kh3)', () => {
    expect(parseDiceExpr('4d6dh1')).toEqual({ count: 4, sides: 6, modifier: 0, keep: { mode: 'dh', n: 1 } });
    expect(parseDiceExpr('4d6kh3')).toEqual({ count: 4, sides: 6, modifier: 0, keep: { mode: 'kh', n: 3 } });
  });

  it('is case-insensitive on the keep/drop clause and tolerates whitespace', () => {
    expect(parseDiceExpr('2D20KH1')).toEqual({ count: 2, sides: 20, modifier: 0, keep: { mode: 'kh', n: 1 } });
    expect(parseDiceExpr('2d20 kh 1 + 3')).toEqual({ count: 2, sides: 20, modifier: 3, keep: { mode: 'kh', n: 1 } });
  });

  it('rejects keep N greater than the dice count (2d20kh3)', () => {
    expect(() => parseDiceExpr('2d20kh3')).toThrow(/Keep count must be between 1 and/);
  });

  it('rejects dropping every die (2d20dl2 leaves nothing)', () => {
    expect(() => parseDiceExpr('2d20dl2')).toThrow(/Drop count must be between/);
  });

  it.each(['2d20k1', '2d20kx1', '2d20kh', '2d20kh0', 'kh1', '2d20hk1'])(
    'rejects malformed keep/drop expression %p',
    (expr) => {
      expect(() => parseDiceExpr(expr)).toThrow(BadRequestException);
    },
  );
});

describe('dice — rollDice', () => {
  it('returns count rolls, each within [1, sides]', () => {
    for (let i = 0; i < 200; i++) {
      const { rolls } = rollDice('3d6');
      expect(rolls).toHaveLength(3);
      for (const r of rolls) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(6);
      }
    }
  });

  it('total equals sum(rolls) + modifier', () => {
    for (let i = 0; i < 200; i++) {
      const { rolls, total } = rollDice('2d8+5');
      expect(total).toBe(rolls.reduce((s, r) => s + r, 0) + 5);
    }
  });

  it('echoes the original expression back', () => {
    expect(rollDice('1d20-2').expr).toBe('1d20-2');
  });

  it('applies a negative modifier to the total', () => {
    const { rolls, total } = rollDice('1d4-1');
    expect(total).toBe(rolls[0] - 1);
  });

  it('advantage (2d20kh1): rolls both, keeps the higher, total = kept', () => {
    for (let i = 0; i < 300; i++) {
      const { rolls, kept, total } = rollDice('2d20kh1');
      expect(rolls).toHaveLength(2);
      expect(kept).toEqual([Math.max(rolls[0], rolls[1])]);
      expect(total).toBe(Math.max(rolls[0], rolls[1]));
    }
  });

  it('disadvantage (2d20kl1): keeps the lower die', () => {
    for (let i = 0; i < 300; i++) {
      const { rolls, kept, total } = rollDice('2d20kl1');
      expect(kept).toEqual([Math.min(rolls[0], rolls[1])]);
      expect(total).toBe(Math.min(rolls[0], rolls[1]));
    }
  });

  it('stat-gen (4d6dl1): rolls 4, drops the single lowest, sums the other 3', () => {
    for (let i = 0; i < 300; i++) {
      const { rolls, kept, total } = rollDice('4d6dl1');
      expect(rolls).toHaveLength(4);
      expect(kept).toHaveLength(3);
      const sortedAsc = [...rolls].sort((a, b) => a - b);
      // kept is exactly the top 3 by value (as a multiset).
      expect([...kept!].sort((a, b) => a - b)).toEqual(sortedAsc.slice(1));
      expect(total).toBe(sortedAsc.slice(1).reduce((s, r) => s + r, 0));
      // kept preserves original roll order (subsequence of rolls).
      expect(kept).toEqual(rolls.filter((_, idx) => idx !== rolls.indexOf(sortedAsc[0])));
    }
  });

  it('keep-highest-3 (4d6kh3) equals drop-lowest-1 in total', () => {
    for (let i = 0; i < 100; i++) {
      const { rolls, kept, total } = rollDice('4d6kh3');
      const sortedAsc = [...rolls].sort((a, b) => a - b);
      expect(total).toBe(sortedAsc.slice(1).reduce((s, r) => s + r, 0));
      expect(kept).toHaveLength(3);
    }
  });

  it('kept dice are a subset of rolls and never exceed the total picture', () => {
    const { rolls, kept, total } = rollDice('2d20kh1+5');
    expect(rolls).toHaveLength(2);
    expect(kept).toHaveLength(1);
    expect(total).toBe(kept![0] + 5);
  });

  it('omits kept for a plain roll (no keep/drop clause)', () => {
    expect(rollDice('2d6').kept).toBeUndefined();
  });
});

describe('dice — rollInitiative', () => {
  it('is a d20 plus the modifier: within [1+mod, 20+mod]', () => {
    for (let i = 0; i < 500; i++) {
      const v = rollInitiative(3);
      expect(v).toBeGreaterThanOrEqual(1 + 3);
      expect(v).toBeLessThanOrEqual(20 + 3);
    }
  });

  it('handles a negative modifier', () => {
    for (let i = 0; i < 500; i++) {
      const v = rollInitiative(-2);
      expect(v).toBeGreaterThanOrEqual(1 - 2);
      expect(v).toBeLessThanOrEqual(20 - 2);
    }
  });
});

// ---------------------------------------------------------------------------
// Compound dice expressions (issue #536): a sum of die terms + integer modifiers,
// e.g. "1d20+1d4+3", "2d6-1d4-2", "+5", "-1d4". Backward-compatible with the classic
// single-term "NdM+K" shape — those still parse and roll identically to before.
// ---------------------------------------------------------------------------

describe('dice — parseCompoundDiceExpr', () => {
  it('parses a single die term (one element)', () => {
    expect(parseCompoundDiceExpr('2d6')).toEqual([{ kind: 'die', count: 2, sides: 6 }]);
  });

  it('parses a single die term with a modifier (two elements)', () => {
    expect(parseCompoundDiceExpr('2d6+3')).toEqual([
      { kind: 'die', count: 2, sides: 6 },
      { kind: 'modifier', value: 3 },
    ]);
  });

  it('parses mixed dice + modifiers (1d20+1d4+3)', () => {
    expect(parseCompoundDiceExpr('1d20+1d4+3')).toEqual([
      { kind: 'die', count: 1, sides: 20 },
      { kind: 'die', count: 1, sides: 4 },
      { kind: 'modifier', value: 3 },
    ]);
  });

  it('parses mixed dice + modifiers (2d6-1d4-2): the subtracted die carries sign -', () => {
    expect(parseCompoundDiceExpr('2d6-1d4-2')).toEqual([
      { kind: 'die', count: 2, sides: 6 },
      { kind: 'die', count: 1, sides: 4, sign: '-' },
      { kind: 'modifier', value: -2 },
    ]);
  });

  it('parses a leading negative die term (-1d4)', () => {
    expect(parseCompoundDiceExpr('-1d4')).toEqual([{ kind: 'die', count: 1, sides: 4, sign: '-' }]);
  });

  it('parses a bare signed modifier (+5 / -2)', () => {
    expect(parseCompoundDiceExpr('+5')).toEqual([{ kind: 'modifier', value: 5 }]);
    expect(parseCompoundDiceExpr('-2')).toEqual([{ kind: 'modifier', value: -2 }]);
  });

  it('parses a bare die (2d6) and a default-count die (d20)', () => {
    expect(parseCompoundDiceExpr('2d6')).toEqual([{ kind: 'die', count: 2, sides: 6 }]);
    expect(parseCompoundDiceExpr('d20')).toEqual([{ kind: 'die', count: 1, sides: 20 }]);
  });

  it('preserves a per-term keep/drop clause (1d20+2d20kh1+3)', () => {
    expect(parseCompoundDiceExpr('1d20+2d20kh1+3')).toEqual([
      { kind: 'die', count: 1, sides: 20 },
      { kind: 'die', count: 2, sides: 20, keep: { mode: 'kh', n: 1 } },
      { kind: 'modifier', value: 3 },
    ]);
  });

  it('tolerates surrounding and inter-term whitespace', () => {
    expect(parseCompoundDiceExpr('  1d20 + 1d4 + 3  ')).toEqual([
      { kind: 'die', count: 1, sides: 20 },
      { kind: 'die', count: 1, sides: 4 },
      { kind: 'modifier', value: 3 },
    ]);
  });

  it('is case-insensitive on the "d" and the keep/drop clause', () => {
    expect(parseCompoundDiceExpr('1D20+2D20KH1')).toEqual([
      { kind: 'die', count: 1, sides: 20 },
      { kind: 'die', count: 2, sides: 20, keep: { mode: 'kh', n: 1 } },
    ]);
  });

  it.each(['', 'abc', '1d20+', '1d20++3', '1d20 + + 3', 'd20 plus 3', '1d20+1d', '1d20+ +3'])(
    'rejects malformed compound expression %p',
    (expr) => {
      expect(() => parseCompoundDiceExpr(expr)).toThrow(BadRequestException);
    },
  );

  it('rejects a non-polyhedral die mid-expression (1d20+1d7)', () => {
    expect(() => parseCompoundDiceExpr('1d20+1d7')).toThrow(/sides must be one of/);
  });

  it('rejects a count above the cap mid-expression (1d20+21d6)', () => {
    expect(() => parseCompoundDiceExpr('1d20+21d6')).toThrow(/count must be between 1 and 20/);
  });

  it('rejects a modifier beyond +/-999 mid-expression', () => {
    expect(() => parseCompoundDiceExpr('1d20+1000')).toThrow(BadRequestException);
  });

  it('rejects a keep N greater than its own term dice count (1d20+2d20kh3)', () => {
    expect(() => parseCompoundDiceExpr('1d20+2d20kh3')).toThrow(/Keep count must be between 1 and/);
  });
});

describe('dice — parseDiceExpr (single-term view, backward compat)', () => {
  // The legacy single-term parser still returns the classic {count, sides, modifier, keep}
  // shape for any NdM+K expression — it now delegates to the compound parser and folds the
  // modifier term in. Every legacy assertion from the original suite must still hold.
  it('parses NdM+K, d20, negative modifiers, and whitespace exactly as before', () => {
    expect(parseDiceExpr('2d6+3')).toEqual({ count: 2, sides: 6, modifier: 3 });
    expect(parseDiceExpr('d20')).toEqual({ count: 1, sides: 20, modifier: 0 });
    expect(parseDiceExpr('2d6-1')).toEqual({ count: 2, sides: 6, modifier: -1 });
    expect(parseDiceExpr('  1d20 + 3 ')).toEqual({ count: 1, sides: 20, modifier: 3 });
    expect(parseDiceExpr('2d20kh1+5')).toEqual({
      count: 2,
      sides: 20,
      modifier: 5,
      keep: { mode: 'kh', n: 1 },
    });
  });

  it('rejects a genuinely compound expression (more than one die term)', () => {
    // parseDiceExpr is the single-die API; compound callers must use parseCompoundDiceExpr.
    expect(() => parseDiceExpr('1d20+1d4+3')).toThrow(BadRequestException);
  });

  it('rejects a bare modifier (no die term) — that is a compound-only shape', () => {
    // rollDice('+5') handles bare modifiers via the compound path; the legacy single-die
    // view has no die to describe, so it 400s.
    expect(() => parseDiceExpr('+5')).toThrow(BadRequestException);
  });
});

describe('dice — rollDice (compound)', () => {
  it('rolls every die term and sums with modifiers (1d20+1d4+3)', () => {
    for (let i = 0; i < 300; i++) {
      const { rolls, total, terms } = rollDice('1d20+1d4+3');
      expect(rolls).toHaveLength(2); // 1d20 + 1d4 = 2 dice total
      const [d20, d4] = rolls;
      expect(d20).toBeGreaterThanOrEqual(1);
      expect(d20).toBeLessThanOrEqual(20);
      expect(d4).toBeGreaterThanOrEqual(1);
      expect(d4).toBeLessThanOrEqual(4);
      expect(total).toBe(d20 + d4 + 3);
      // Compound => breakdown is present, one entry per term.
      expect(terms).toHaveLength(3);
    }
  });

  it('handles mixed dice + negative modifiers (2d6-1d4-2)', () => {
    for (let i = 0; i < 300; i++) {
      const { rolls, total } = rollDice('2d6-1d4-2');
      expect(rolls).toHaveLength(3); // 2d6 + 1d4 = 3 dice
      const twoD6 = rolls[0] + rolls[1];
      const d4 = rolls[2];
      expect(total).toBe(twoD6 - d4 - 2);
    }
  });

  it('rolls a bare signed modifier (+5) with no dice', () => {
    const { rolls, total, terms } = rollDice('+5');
    expect(rolls).toHaveLength(0);
    expect(total).toBe(5);
    // A single modifier term is not "compound" (1 term) -> no breakdown emitted.
    expect(terms).toBeUndefined();
  });

  it('rolls a bare negative modifier (-2)', () => {
    const { rolls, total } = rollDice('-2');
    expect(rolls).toHaveLength(0);
    expect(total).toBe(-2);
  });

  it('rolls a bare die (2d6) identically to the legacy path', () => {
    const { rolls, terms } = rollDice('2d6');
    expect(rolls).toHaveLength(2);
    expect(terms).toBeUndefined(); // single term -> no breakdown
  });

  it('preserves per-term keep/drop (1d20+2d20kh1+3): kept honors the second term', () => {
    for (let i = 0; i < 300; i++) {
      const { rolls, total, terms } = rollDice('1d20+2d20kh1+3');
      expect(rolls).toHaveLength(3); // 1d20 + 2d20 = 3 dice
      const [a, b, c] = rolls; // a = first 1d20, [b,c] = the 2d20kh1 pool
      const keptSecond = Math.max(b, c);
      expect(total).toBe(a + keptSecond + 3);
      // 2 die terms => flat `kept` is omitted (ambiguous); per-term kept lives in terms[].
      expect(rollDice('1d20+2d20kh1+3').kept).toBeUndefined();
      expect(terms).toHaveLength(3);
      expect(terms![0].term).toBe('1d20');
      expect(terms![0].value).toBe(a);
      expect(terms![1].term).toBe('2d20kh1');
      expect(terms![1].kept).toEqual([keptSecond]);
      expect(terms![1].value).toBe(keptSecond);
      expect(terms![2].term).toBe('+3');
      expect(terms![2].value).toBe(3);
    }
  });

  it('breakdown sums to the total and carries each term rolls', () => {
    for (let i = 0; i < 200; i++) {
      const { rolls, total, terms } = rollDice('2d6+1d8-1');
      expect(terms!.reduce((s, t) => s + t.value, 0)).toBe(total);
      // Every die term's rolls are present; the modifier term carries none.
      const dieTerms = terms!.filter((t) => t.rolls !== undefined);
      expect(dieTerms).toHaveLength(2);
      const flat: number[] = [];
      for (const t of dieTerms) flat.push(...t.rolls!);
      expect(flat).toEqual(rolls);
    }
  });

  it('breakdown term labels render with signs (1d20+1d4+3 -> "1d20","1d4","+3")', () => {
    const { terms } = rollDice('1d20+1d4+3');
    expect(terms!.map((t) => t.term)).toEqual(['1d20', '1d4', '+3']);
  });

  it('breakdown term labels render negatives (2d6-1d4-2 -> "2d6","-1d4","-2")', () => {
    // The first die has no sign (it's the leading positive term); subsequent dice and
    // modifiers carry their sign so the breakdown reads as a signed sum.
    const { terms } = rollDice('2d6-1d4-2');
    expect(terms!.map((t) => t.term)).toEqual(['2d6', '-1d4', '-2']);
  });

  it('rolls every die within [1, sides] across many compound runs', () => {
    for (let i = 0; i < 200; i++) {
      const { rolls } = rollDice('4d6+2d20+1d100+5');
      const [d6a, d6b, d6c, d6d, d20a, d20b, d100] = rolls;
      for (const v of [d6a, d6b, d6c, d6d]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(6);
      }
      for (const v of [d20a, d20b]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(20);
      }
      expect(d100).toBeGreaterThanOrEqual(1);
      expect(d100).toBeLessThanOrEqual(100);
    }
  });

  it('echoes the original compound expression back verbatim', () => {
    expect(rollDice('1d20+1d4+3').expr).toBe('1d20+1d4+3');
    expect(rollDice('2d6-1d4-2').expr).toBe('2d6-1d4-2');
  });

  it('total can go negative (1d4-100)', () => {
    const { total } = rollDice('1d4-100');
    expect(total).toBeGreaterThanOrEqual(1 - 100);
    expect(total).toBeLessThanOrEqual(4 - 100);
  });

  it('rejects an out-of-bounds die hidden mid-expression via the 400 path', () => {
    expect(() => rollDice('1d20+1d7+3')).toThrow(BadRequestException);
  });
});
