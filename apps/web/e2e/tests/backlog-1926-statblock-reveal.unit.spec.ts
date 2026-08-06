import { expect, test } from '@playwright/test';
import type { Combatant } from '@campfire/schema';
import { dismissKillPrompt, shouldShowKillPrompt } from '../../src/features/encounters/combat/statblockReveal';

/**
 * Issue #1926 — reveal a monster's statblock to players, with a one-tap kill
 * prompt. `Combatant.statblockRevealed` and the server-side redaction it gates
 * are covered server-side (apps/server/test/encounters.e2e-spec.ts); this
 * covers only the purely client-local kill-prompt helper: it fires once per
 * combatant, and a dismissal sticks for the rest of the session.
 */

function monster(overrides: Partial<Combatant> = {}): Pick<Combatant, 'id' | 'kind' | 'hpCurrent' | 'statblockRevealed'> {
  return { id: 1, kind: 'monster', hpCurrent: 0, statblockRevealed: false, ...overrides };
}

test.describe('backlog issue #1926 — statblock reveal kill prompt', () => {
  test('shows for a monster/npc at 0 HP with an unrevealed statblock, not otherwise', () => {
    const dismissed = new Set<number>();
    expect(shouldShowKillPrompt(monster(), dismissed)).toBe(true);
    expect(shouldShowKillPrompt(monster({ kind: 'npc' }), dismissed)).toBe(true);

    // Not for a character.
    expect(shouldShowKillPrompt(monster({ kind: 'character' }), dismissed)).toBe(false);
    // Not above 0 HP.
    expect(shouldShowKillPrompt(monster({ hpCurrent: 1 }), dismissed)).toBe(false);
    // Not when HP is redacted (null) — this prompt only ever renders on the DM's own
    // (unredacted) view; a null hpCurrent means "don't know", not "at 0".
    expect(shouldShowKillPrompt(monster({ hpCurrent: null }), dismissed)).toBe(false);
    // Not once already revealed.
    expect(shouldShowKillPrompt(monster({ statblockRevealed: true }), dismissed)).toBe(false);
  });

  test('fires once per combatant: dismissal sticks for the session and does not affect other combatants', () => {
    let dismissed = new Set<number>();
    const troll = monster({ id: 7 });
    const goblin = monster({ id: 8 });

    expect(shouldShowKillPrompt(troll, dismissed)).toBe(true);
    dismissed = dismissKillPrompt(dismissed, troll.id);
    expect(shouldShowKillPrompt(troll, dismissed)).toBe(false);

    // A different combatant at 0 HP is untouched by the first one's dismissal.
    expect(shouldShowKillPrompt(goblin, dismissed)).toBe(true);

    // Once dismissed, it stays dismissed even if HP fluctuates and drops to 0 again
    // (e.g. healed then re-damaged) within the same session — no re-arming.
    const healedThenDropped = monster({ id: 7, hpCurrent: 0 });
    expect(shouldShowKillPrompt(healedThenDropped, dismissed)).toBe(false);
  });

  test('dismissKillPrompt does not mutate the input set (immutable update, safe for React state)', () => {
    const before = new Set<number>([1]);
    const after = dismissKillPrompt(before, 2);
    expect(before.has(2)).toBe(false);
    expect(after.has(1)).toBe(true);
    expect(after.has(2)).toBe(true);
  });
});
