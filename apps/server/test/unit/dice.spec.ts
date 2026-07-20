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
