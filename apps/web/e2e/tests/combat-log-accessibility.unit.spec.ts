import { expect, test } from '@playwright/test';
import type { EncounterEvent, EncounterEventType } from '@campfire/schema';
import {
  advanceCombatLogAnnouncements,
  formatCombatLogAnnouncement,
  formatCombatLogAnnouncementBatch,
  formatCombatLogChainDetails,
  formatCombatLogChainSummary,
  formatCombatLogEventSummary,
  groupCombatLogEvents,
} from '../../src/features/encounters/combatLogAccessibility';

function event(id: number, type: EncounterEventType, patch: Partial<EncounterEvent> = {}): EncounterEvent {
  return {
    id,
    encounterId: 7,
    round: 2,
    type,
    actor: null,
    target: null,
    actorId: null,
    targetId: null,
    detail: '',
    chainId: null,
    parentEventId: null,
    phase: null,
    performedBy: null,
    metadata: {},
    createdAt: `2026-07-22T12:00:${String(id).padStart(2, '0')}.000Z`,
    ...patch,
  };
}

test.describe('combat-log accessibility formatting', () => {
  test('formats every event family with available actor, target, and outcome context', () => {
    const cases: Array<{ value: EncounterEvent; expected: string }> = [
      { value: event(1, 'turn', { actor: 'Mira', target: 'Mira', detail: "Mira's turn" }), expected: "Actor: Mira. Outcome: Mira's turn" },
      { value: event(2, 'damage', { actor: 'Mira', target: 'Ash Hound', detail: 'dealt 7 damage' }), expected: 'Actor: Mira. Target: Ash Hound. Outcome: dealt 7 damage' },
      { value: event(3, 'heal', { target: 'Mira', detail: 'healed 4 HP' }), expected: 'Target: Mira. Outcome: healed 4 HP' },
      { value: event(4, 'condition', { target: 'Ash Hound', detail: 'gained Prone' }), expected: 'Target: Ash Hound. Outcome: gained Prone' },
      { value: event(5, 'death', { target: 'Ash Hound', detail: 'dropped to 0 HP' }), expected: 'Target: Ash Hound. Outcome: dropped to 0 HP' },
      { value: event(5, 'death', { actor: 'Mira', target: 'Ash Hound', detail: 'dropped to 0 HP' }), expected: 'Actor: Mira. Target: Ash Hound. Outcome: dropped to 0 HP' },
      { value: event(6, 'note', { actor: 'Mira', detail: 'The bridge is unstable' }), expected: 'Actor: Mira. Outcome: The bridge is unstable' },
      { value: event(7, 'override', { actor: 'Game Master', target: 'Ash Hound', detail: 'set initiative to 12' }), expected: 'Actor: Game Master. Target: Ash Hound. Outcome: set initiative to 12' },
      { value: event(8, 'correction', { actor: 'Game Master', target: 'Ash Hound', detail: 'corrected damage to 4' }), expected: 'Actor: Game Master. Target: Ash Hound. Outcome: corrected damage to 4' },
    ];

    for (const { value, expected } of cases) {
      expect(formatCombatLogAnnouncement(value)).toBe(`Round 2. ${expected}.`);
    }
    expect(formatCombatLogEventSummary(cases[1].value)).toBe('Mira to Ash Hound: dealt 7 damage');
    expect(formatCombatLogEventSummary(cases[0].value)).toBe("Mira's turn");
    expect(formatCombatLogEventSummary(cases[2].value)).toBe('Mira healed 4 HP');
  });

  test('keeps redacted-monster announcements limited to the already-safe event payload', () => {
    const announcement = formatCombatLogAnnouncement(
      event(9, 'damage', { target: 'Secret Ash Hound', detail: 'took 1 damage' }),
    );
    expect(announcement).toBe('Round 2. Target: Secret Ash Hound. Outcome: took 1 damage.');
    expect(announcement).not.toContain('29 of 30');
    expect(announcement).not.toContain('hit points');
  });

  test('silences initial history, deduplicates refetches, and preserves reconnect-burst order', () => {
    const initial = [event(1, 'turn', { actor: 'Mira', detail: "Mira's turn" })];
    const baseline = advanceCombatLogAnnouncements(initial, null);
    expect(baseline.appendedEvents).toEqual([]);

    const damage = event(2, 'damage', { target: 'Ash Hound', detail: 'took 1 damage' });
    const appended = advanceCombatLogAnnouncements([...initial, damage], baseline.cursor);
    expect(appended.appendedEvents.map((entry) => entry.id)).toEqual([2]);
    expect(appended.cursor).toBe(baseline.cursor);
    expect(appended.cursor.seenEventIds).toBe(baseline.cursor.seenEventIds);

    const duplicateRefetch = advanceCombatLogAnnouncements([...initial, damage], appended.cursor);
    expect(duplicateRefetch.appendedEvents).toEqual([]);

    const condition = event(3, 'condition', { target: 'Ash Hound', detail: 'gained Prone' });
    const note = event(4, 'note', { actor: 'Mira', detail: 'The bridge is unstable' });
    const burst = advanceCombatLogAnnouncements([...initial, damage, condition, note, note], duplicateRefetch.cursor);
    expect(burst.appendedEvents.map((entry) => entry.id)).toEqual([3, 4]);
    expect(formatCombatLogAnnouncementBatch(burst.appendedEvents)).toContain('2 new combat log events');
    expect(formatCombatLogAnnouncementBatch(burst.appendedEvents).indexOf('gained Prone')).toBeLessThan(
      formatCombatLogAnnouncementBatch(burst.appendedEvents).indexOf('bridge is unstable'),
    );
  });

  test('groups correlated action chains and formats expandable summaries (issue #426)', () => {
    const chainId = 'chain-test-1';
    const events = [
      event(10, 'note', { actor: 'Mira', chainId, phase: 'declare', metadata: { actionName: 'Fireball', mode: 'save' }, detail: 'used Fireball' }),
      event(11, 'roll', { actor: 'Mira', target: 'Ash Hound', chainId, phase: 'ruling', detail: 'failed save', metadata: { playerText: 'Ash Hound failed the save' } }),
      event(12, 'damage', { actor: 'Mira', target: 'Ash Hound', chainId, phase: 'consequence', detail: 'took 14 damage' }),
    ];
    const chains = groupCombatLogEvents(events);
    expect(chains).toHaveLength(1);
    expect(chains[0].events).toHaveLength(3);
    expect(formatCombatLogChainSummary(chains[0])).toBe('Mira: used Fireball');
    expect(formatCombatLogChainDetails(chains[0])).toEqual(['Ash Hound: Ash Hound failed the save', 'Ash Hound: took 14 damage']);
  });
});
