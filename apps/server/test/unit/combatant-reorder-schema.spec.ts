/**
 * `CombatantReorderRequest` (issue #1923) — the DM-only manual initiative reorder
 * body. `afterCombatantId` is a union of a positive combatant `Id` and the literal
 * `'top'`; `expectedTurnVersion` is a required non-negative integer CAS token.
 */
import { CombatantReorderRequest } from '@campfire/schema';

describe('CombatantReorderRequest (issue #1923)', () => {
  it('accepts a positive combatant id for afterCombatantId', () => {
    const parsed = CombatantReorderRequest.safeParse({ afterCombatantId: 42, expectedTurnVersion: 0 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.afterCombatantId).toBe(42);
  });

  it("accepts the literal 'top'", () => {
    const parsed = CombatantReorderRequest.safeParse({ afterCombatantId: 'top', expectedTurnVersion: 3 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.afterCombatantId).toBe('top');
  });

  it('rejects an arbitrary string other than the literal top', () => {
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 'bottom', expectedTurnVersion: 0 }).success).toBe(false);
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 'TOP', expectedTurnVersion: 0 }).success).toBe(false);
  });

  it('rejects a non-positive or non-integer afterCombatantId', () => {
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 0, expectedTurnVersion: 0 }).success).toBe(false);
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: -1, expectedTurnVersion: 0 }).success).toBe(false);
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 1.5, expectedTurnVersion: 0 }).success).toBe(false);
  });

  it('accepts omitted expectedTurnVersion', () => {
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 'top' }).success).toBe(true);
  });

  it('rejects a negative or non-integer expectedTurnVersion', () => {
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 'top', expectedTurnVersion: -1 }).success).toBe(false);
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 'top', expectedTurnVersion: 1.5 }).success).toBe(false);
  });

  it('accepts expectedTurnVersion of 0 (a fresh, never-advanced encounter)', () => {
    expect(CombatantReorderRequest.safeParse({ afterCombatantId: 'top', expectedTurnVersion: 0 }).success).toBe(true);
  });
});
