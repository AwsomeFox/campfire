import { expect, test } from '@playwright/test';
import { parseAiDmStreamEvent } from './util';
import {
  invalidateForToolEvent,
  invalidationKeysForResource,
  resolveToolActivity,
  toolResource,
  type ToolStreamEvent,
} from '../../src/features/ai-dm/toolActivity';
import { emptyTranscript, transcriptReducer } from '../../src/features/ai-dm/transcript';
import { queryKeys } from '../../src/lib/query';

/**
 * Issue #825 — encounter resource identity on AI tool activity: parse, chip
 * deep-links, invalidation keys, and transcript persistence.
 */

const at = '2026-07-23T12:00:00.000Z';

function tool(partial: Partial<ToolStreamEvent> & Pick<ToolStreamEvent, 'name'>): ToolStreamEvent {
  return {
    type: 'tool',
    campaignId: 1,
    isError: false,
    proposed: false,
    at,
    ...partial,
  };
}

test.describe('parseAiDmStreamEvent tool identity (#825)', () => {
  test('accepts optional positive encounterId', () => {
    expect(
      parseAiDmStreamEvent({
        type: 'tool',
        campaignId: 1,
        name: 'next_turn',
        isError: false,
        proposed: false,
        encounterId: 42,
        at,
      }),
    ).toEqual({
      type: 'tool',
      campaignId: 1,
      name: 'next_turn',
      isError: false,
      proposed: false,
      encounterId: 42,
      at,
    });
  });


});

test.describe('resolveToolActivity encounter identity (#825)', () => {
  test('deep-links the event encounterId, not the open page context', () => {
    const chip = resolveToolActivity(tool({ name: 'update_combatant', encounterId: 7 }), {
      campaignId: 1,
      encounterId: 3,
    });
    expect(toolResource('update_combatant')).toBe('encounter');
    expect(chip.href).toBe('/c/1/encounters/7');
    expect(chip.label).toContain('other encounter');
  });

  // Issue #1904 review finding: roll_combatant_initiative starts with "roll_", which the
  // prefix heuristic in toolResource() would otherwise classify as 'dice' BEFORE ever
  // reaching the combatant/encounter substring rules — exactly why roll_initiative and
  // roll_death_save need (and have) an exact-name override below. Without one, the open
  // combat tracker never refetches after an AI-driven per-combatant initiative roll, and
  // the cross-encounter toast filter (gated on resource === 'encounter', #825) stops
  // scoping the event to the fight it actually hit.
  test('roll_combatant_initiative classifies as encounter, not dice, and deep-links like its siblings', () => {
    expect(toolResource('roll_combatant_initiative')).toBe('encounter');
    const chip = resolveToolActivity(tool({ name: 'roll_combatant_initiative', encounterId: 7 }), {
      campaignId: 1,
      encounterId: 3,
    });
    expect(chip.href).toBe('/c/1/encounters/7');
    expect(chip.label).toContain('other encounter');
  });

  test('matching ids keep a plain label and link the same fight', () => {
    const chip = resolveToolActivity(tool({ name: 'next_turn', encounterId: 3 }), {
      campaignId: 1,
      encounterId: 3,
    });
    expect(chip.href).toBe('/c/1/encounters/3');
    expect(chip.label).toBe('Next turn');
    expect(chip.label).not.toContain('other encounter');
  });

  test('failed cross-encounter tools still link the actual fight', () => {
    const chip = resolveToolActivity(tool({ name: 'next_turn', encounterId: 7, isError: true }), {
      campaignId: 1,
      encounterId: 3,
    });
    expect(chip.variant).toBe('error');
    expect(chip.href).toBe('/c/1/encounters/7');
    expect(chip.label).toContain('other encounter');
  });
});

test.describe('invalidateForToolEvent prefers event encounterId (#825)', () => {
  test('invalidation keys target the event fight over page context', () => {
    const keys = invalidationKeysForResource('encounter', {
      campaignId: 1,
      encounterId: 7,
    });
    expect(keys.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.encounter(7)))).toBe(true);
    expect(keys.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.encounter(3)))).toBe(false);

    const calls: unknown[] = [];
    const client = {
      invalidateQueries: (opts: { queryKey: unknown }) => {
        calls.push(opts.queryKey);
        return Promise.resolve();
      },
    };
    invalidateForToolEvent(
      client as never,
      tool({ name: 'add_combatant', encounterId: 7 }),
      { campaignId: 1, encounterId: 3 },
    );
    expect(calls.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.encounter(7)))).toBe(true);
    expect(calls.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.encounter(3)))).toBe(false);
  });
});

test.describe('transcript preserves tool encounterId across hydrate (#825)', () => {
  test('tool entries keep encounterId through reducer + JSON round-trip', () => {
    const state = transcriptReducer(emptyTranscript, {
      type: 'stream',
      event: tool({ name: 'roll_initiative', encounterId: 11 }),
    });
    const entry = state.entries[0];
    expect(entry).toMatchObject({ kind: 'tool', name: 'roll_initiative', encounterId: 11 });

    const rehydrated = transcriptReducer(emptyTranscript, {
      type: 'hydrate',
      state: JSON.parse(JSON.stringify(state)),
    });
    expect(rehydrated.entries[0]).toMatchObject({ kind: 'tool', encounterId: 11 });
  });
});
/**
 * Issue #1501 — the DM's "undo the AI's last action" control reads
 * `session.lastUndoableCommit`, which the server arms on a successful resolve_action /
 * apply_action and clears on undo_action. The `tool` stream frame for those names must
 * invalidate the ai-dm session read, or the header button + UndoSnackbar stay cached until
 * an unrelated refresh (Devin review on PR #1813).
 */
test.describe('invalidateForToolEvent refreshes the DM undo lever (#1501)', () => {
  function captureClient(): { client: unknown; calls: unknown[] } {
    const calls: unknown[] = [];
    const client = {
      invalidateQueries: (opts: { queryKey: unknown }) => {
        calls.push(opts.queryKey);
        return Promise.resolve();
      },
    };
    return { client, calls };
  }

  test('resolve_action / apply_action / undo_action invalidate the ai-dm session read', () => {
    for (const name of ['resolve_action', 'apply_action', 'undo_action'] as const) {
      const { client, calls } = captureClient();
      invalidateForToolEvent(client as never, tool({ name }), { campaignId: 1 });
      expect(
        calls.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.aiDmSession(1))),
      ).toBe(true);
    }
  });

  test('a non-undo-lever tool does NOT invalidate the ai-dm session read', () => {
    const { client, calls } = captureClient();
    invalidateForToolEvent(client as never, tool({ name: 'next_turn' }), {
      campaignId: 1,
      encounterId: 3,
    });
    expect(
      calls.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.aiDmSession(1))),
    ).toBe(false);
  });

  test('an errored undo-lever tool does NOT invalidate the ai-dm session read', () => {
    const { client, calls } = captureClient();
    invalidateForToolEvent(client as never, tool({ name: 'resolve_action', isError: true }), {
      campaignId: 1,
    });
    expect(
      calls.some((k) => JSON.stringify(k) === JSON.stringify(queryKeys.aiDmSession(1))),
    ).toBe(false);
  });
});