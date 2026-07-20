import { BadRequestException } from '@nestjs/common';
import { parseDiceExpr, rollDice, rollInitiative } from '../../src/common/dice';

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
