import type { EncounterEvent } from '@campfire/schema';
import { computeDnd5eEncounterDifficulty } from '@campfire/schema';
import {
  aftermathOutcome,
  buildEncounterAftermathRecapDraft,
  formatAftermathCombatLogLine,
  selectCombatLogHighlights,
  suggestedXpFromDifficulty,
} from '../../src/modules/encounters/encounter-aftermath.logic';

function combatant(
  over: Partial<{ name: string; kind: 'character' | 'monster' | 'npc'; hpCurrent: number; deathState: 'none' | 'dying' | 'stable' | 'dead' }> = {},
) {
  return {
    name: 'Test',
    kind: 'character' as const,
    hpCurrent: 10,
    hpBand: null as string | null,
    deathState: 'none' as const,
    ...over,
  };
}

function event(over: Partial<EncounterEvent>): EncounterEvent {
  return {
    id: 1,
    encounterId: 1,
    round: 1,
    type: 'damage',
    actor: 'Mira',
    target: 'Goblin',
    detail: 'dealt 7 damage',
    phase: null,
    performedBy: null,
    metadata: {},
    chainId: null,
    actorId: null,
    targetId: null,
    createdAt: '2026-07-25T12:00:00.000Z',
    ...over,
  } as EncounterEvent;
}

describe('encounter aftermath logic (issue #473)', () => {
  it('splits dead vs downed vs survivors', () => {
    const outcome = aftermathOutcome(
      [
        combatant({ name: 'PC', kind: 'character', hpCurrent: 0, deathState: 'dying' }),
        combatant({ name: 'Goblin', kind: 'monster', hpCurrent: 0 }),
        combatant({ name: 'Rogue', kind: 'character', hpCurrent: 8 }),
      ] as Parameters<typeof aftermathOutcome>[0],
      3,
    );
    expect(outcome.downed.map((c) => c.name)).toEqual(['PC']);
    expect(outcome.dead.map((c) => c.name)).toEqual(['Goblin']);
    expect(outcome.survivors.map((c) => c.name)).toEqual(['Rogue']);
    expect(outcome.rounds).toBe(3);
  });

  it('formats combat-log lines for recap highlights', () => {
    expect(formatAftermathCombatLogLine(event({ type: 'turn', actor: 'Mira', detail: '' }))).toBe("Mira's turn");
    expect(formatAftermathCombatLogLine(event({}))).toBe('Mira to Goblin: dealt 7 damage');
  });

  it('builds a recap draft with outcome and highlights', () => {
    const encounter = {
      name: 'Ambush',
      status: 'ended' as const,
      round: 2,
      combatants: [combatant({ name: 'Goblin', kind: 'monster', hpCurrent: 0 })],
    };
    const { recapDraft } = buildEncounterAftermathRecapDraft(
      encounter as Parameters<typeof buildEncounterAftermathRecapDraft>[0],
      [event({ type: 'death', detail: 'fell' })],
    );
    expect(recapDraft).toContain('Ambush');
    expect(recapDraft).toContain('## Outcome');
    expect(recapDraft).toContain('Dead/defeated: Goblin');
    expect(recapDraft).toContain('## Combat highlights');
  });

  it('suggests per-character XP from difficulty', () => {
    const difficulty = computeDnd5eEncounterDifficulty({ partyLevels: [3, 3], monsterChallengeRatings: [2, 2] });
    const xp = suggestedXpFromDifficulty(difficulty, 2);
    expect(xp.supported).toBe(true);
    expect(xp.suggestedPartyTotal).toBeGreaterThan(0);
    expect(xp.suggestedPerCharacter).toBeGreaterThan(0);
  });

  it('selectCombatLogHighlights prefers notable events', () => {
    const highlights = selectCombatLogHighlights([
      event({ id: 1, type: 'turn' }),
      event({ id: 2, type: 'death', detail: 'Goblin fell' }),
    ]);
    expect(highlights.some((h) => h.includes('Goblin fell'))).toBe(true);
  });
});
