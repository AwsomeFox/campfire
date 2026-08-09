import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { waitingPromptsKey } from '../../src/features/encounters/vtt/attentionKey';

/**
 * The cockpit reopens and scrolls its panel when the attention key changes, so the key
 * must name every prompt that is up — not whichever one a priority order happens to pick
 * first. A prompt that arrives underneath an existing one is exactly the case the viewer
 * cannot see coming.
 */
test.describe('the cockpit attention key', () => {
  test('is null when nothing is waiting', () => {
    expect(waitingPromptsKey([['concentration', null], ['apply', undefined]])).toBeNull();
    expect(waitingPromptsKey([])).toBeNull();
  });

  test('changes when a second prompt arrives under the first', () => {
    const concentration = { id: 7 };
    const first = waitingPromptsKey([
      ['concentration', concentration],
      ['apply', null],
    ]);
    const second = waitingPromptsKey([
      ['concentration', concentration],
      ['apply', { id: 3 }],
    ]);
    expect(first).toBe('concentration:7');
    expect(second).not.toBe(first);
    expect(second).toContain('apply:3');
  });

  test('changes when one of several is dismissed, so the panel follows what is left', () => {
    const both = waitingPromptsKey([['concentration', { id: 7 }], ['apply', { id: 3 }]]);
    const remaining = waitingPromptsKey([['concentration', null], ['apply', { id: 3 }]]);
    expect(remaining).not.toBe(both);
    expect(remaining).toBe('apply:3');
  });

  test('is stable while the same prompts stay up, so it does not fight the viewer', () => {
    const entries = [['concentration', { id: 7 }], ['apply', { id: 3 }]] as const;
    expect(waitingPromptsKey(entries)).toBe(waitingPromptsKey(entries));
  });

  test('a new prompt of the same kind is a different key', () => {
    expect(waitingPromptsKey([['apply', { id: 3 }]])).not.toBe(waitingPromptsKey([['apply', { id: 4 }]]));
  });
});

test('RunSessionPage feeds every prompt into the key rather than a priority ternary', () => {
  const source = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');
  // Concentration checks are a QUEUE, and one can land on any eligible combatant, so the
  // key spreads all of them rather than naming the head that happens to be on screen.
  expect(source).toContain("...waitingConcentrationChecks.map((check) => ['concentration', check] as const)");
  expect(source).toContain('const waitingConcentrationChecks = orderedCombatants.flatMap');
  expect(source).toContain("['apply', pendingApply]");
  expect(source).toContain("['action', pendingActionUse]");
  expect(source).toContain("['group', pendingGroupActionUse]");
});
