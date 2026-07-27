/**
 * Pending tool-confirmation summaries (issue #1558).
 *
 * The summary is the whole point of the panel: a DM approving `update_character_hp` with no
 * further information is not making an informed decision. These cover the two properties that
 * make the summary safe to trust — it cannot print a name the client was never given, and it
 * never silently drops an argument.
 */
import { expect, test } from '@playwright/test';
import {
  buildToolArgNameLookup,
  summariseToolConfirmation,
} from '../../src/features/ai-dm/toolConfirmationSummary';

const PARTY = buildToolArgNameLookup([
  { id: 3, name: 'Thorne' },
  { id: 4, name: 'Mira' },
]);

test.describe('summariseToolConfirmation (#1558)', () => {
  test('reads as a decision, not a function call', () => {
    expect(summariseToolConfirmation('update_character_hp', { characterId: 3, hpDelta: -7 }, PARTY).headline)
      .toBe('Deal 7 damage to Thorne');
    expect(summariseToolConfirmation('update_character_hp', { characterId: 3, hpDelta: 4 }, PARTY).headline)
      .toBe('Heal Thorne for 4');
    expect(summariseToolConfirmation('update_character_hp', { characterId: 3, hpSet: 0 }, PARTY).headline)
      .toBe("Set Thorne's HP to 0");
    expect(summariseToolConfirmation('next_turn', {}, PARTY).headline).toBe('Advance to the next turn');
    expect(summariseToolConfirmation('remove_combatant', { combatantId: 4 }, PARTY).headline)
      .toBe('Remove Mira from the encounter');
  });

  test('renders an id it cannot resolve AS an id, never as a guess', () => {
    // THE LEAK-SAFETY PROPERTY. The lookup is built from reads the viewer already made under
    // their own permissions, and this module cannot fetch. So a DM-hidden NPC that the client
    // was never given renders as `#99` — there is no code path by which its name could appear
    // here, whatever shape the AI put in the arguments.
    const s = summariseToolConfirmation('update_character_hp', { characterId: 99, hpDelta: -3 }, PARTY);
    expect(s.headline).toBe('Deal 3 damage to #99');
    expect(s.headline).not.toContain('Thorne');
  });

  test('works with no lookup at all', () => {
    expect(summariseToolConfirmation('update_character_hp', { characterId: 3, hpDelta: -7 }).headline)
      .toBe('Deal 7 damage to #3');
  });

  test('reports every argument it did not put in the sentence', () => {
    // A summary that quietly dropped an argument would be worse than a JSON dump: the DM would
    // approve believing they had seen the whole call. `omittedKeys` is what lets the panel say
    // "there is more here" and offer the raw object.
    const s = summariseToolConfirmation(
      'update_character_hp',
      { characterId: 3, hpDelta: -7, reason: 'the trap in the vestibule', encounterId: 12 },
      PARTY,
    );
    expect(s.omittedKeys.sort()).toEqual(['encounterId', 'reason']);

    const clean = summariseToolConfirmation('update_character_hp', { characterId: 3, hpDelta: -7 }, PARTY);
    expect(clean.omittedKeys).toEqual([]);
  });

  test('an unmodelled tool is named honestly rather than narrated', () => {
    // Inventing a sentence for a shape we do not model would produce a summary a DM could not
    // trust. Naming the tool and deferring to the raw arguments is the honest failure.
    const s = summariseToolConfirmation('some_future_tool', { a: 1, b: 'x' });
    expect(s.headline).toBe('some_future_tool');
    expect(s.omittedKeys.sort()).toEqual(['a', 'b']);
  });

  test('handles malformed arguments without throwing', () => {
    // These come from a language model. Every branch has to survive the wrong type.
    for (const args of [
      { characterId: 'three', hpDelta: null },
      { characterId: 3, conditions: 'poisoned' },
      { actorCombatantId: {}, actionName: 42 },
      {},
    ] as Array<Record<string, unknown>>) {
      for (const tool of ['update_character_hp', 'set_character_conditions', 'apply_action', 'award_xp']) {
        expect(() => summariseToolConfirmation(tool, args, PARTY)).not.toThrow();
        expect(summariseToolConfirmation(tool, args, PARTY).headline.length).toBeGreaterThan(0);
      }
    }
  });

  test('buildToolArgNameLookup skips rows without both an id and a name', () => {
    const lookup = buildToolArgNameLookup([
      { id: 1, name: 'Ana' },
      { id: 2, name: '   ' },
      { id: undefined, name: 'Nobody' },
      null,
      undefined,
    ]);
    expect(lookup).toEqual({ 1: 'Ana' });
  });
});
