import type { EncounterEvent } from '@campfire/schema';
import { computeDnd5eEncounterDifficulty, unsupportedEncounterDifficulty } from '@campfire/schema';
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

  it('awards raw XP rather than the difficulty multiplier for six goblins and four PCs (issue #1454)', () => {
    const difficulty = computeDnd5eEncounterDifficulty({
      partyLevels: [3, 3, 3, 3],
      monsterChallengeRatings: [0.25, 0.25, 0.25, 0.25, 0.25, 0.25],
    });
    const xp = suggestedXpFromDifficulty(difficulty, 4);
    expect(difficulty.adjustedXp).toBe(600);
    expect(xp).toMatchObject({
      supported: true,
      suggestedPartyTotal: 300,
      suggestedPerCharacter: 75,
      undistributedXp: 0,
    });
  });

  it('floors an uneven XP split and surfaces its remainder (issue #1454)', () => {
    const difficulty = computeDnd5eEncounterDifficulty({ partyLevels: [1], monsterChallengeRatings: [0.25, 0.25] });
    const xp = suggestedXpFromDifficulty(difficulty, 8);
    expect(xp).toMatchObject({
      suggestedPartyTotal: 100,
      suggestedPerCharacter: 12,
      undistributedXp: 4,
    });
    expect(xp.suggestedPerCharacter! * 8 + xp.undistributedXp!).toBe(xp.suggestedPartyTotal);
  });

  it('does not publish a zero-XP award hand-off when the party is larger than the XP pool', () => {
    const difficulty = computeDnd5eEncounterDifficulty({ partyLevels: [1], monsterChallengeRatings: [0] });
    const xp = suggestedXpFromDifficulty(difficulty, 20);
    expect(xp).toMatchObject({
      suggestedPartyTotal: 10,
      suggestedPerCharacter: null,
      undistributedXp: null,
    });
    expect(xp.warnings.some((warning) => /award manually/i.test(warning))).toBe(true);
  });

  it('does not suggest a party award when no characters participated', () => {
    const xp = suggestedXpFromDifficulty(
      computeDnd5eEncounterDifficulty({ partyLevels: [3], monsterChallengeRatings: [2] }),
      0,
    );
    expect(xp).toMatchObject({ supported: true, suggestedPartyTotal: null, suggestedPerCharacter: null, undistributedXp: null });
    expect(xp.warnings.some((warning) => /no player characters/i.test(warning))).toBe(true);
  });

  it('leaves a single-monster award unchanged and declines unsupported rulesets (issue #1454)', () => {
    const loneMonster = suggestedXpFromDifficulty(
      computeDnd5eEncounterDifficulty({ partyLevels: [3], monsterChallengeRatings: [2] }),
      1,
    );
    expect(loneMonster).toMatchObject({ suggestedPartyTotal: 450, suggestedPerCharacter: 450, undistributedXp: 0 });

    const unsupported = suggestedXpFromDifficulty(
      unsupportedEncounterDifficulty('Example rules', { partyLevels: [3], monsterChallengeRatings: [2] }),
      1,
    );
    expect(unsupported).toMatchObject({
      supported: false,
      suggestedPartyTotal: null,
      suggestedPerCharacter: null,
      undistributedXp: null,
    });
  });

  it('selectCombatLogHighlights prefers notable events', () => {
    const highlights = selectCombatLogHighlights([
      event({ id: 1, type: 'turn' }),
      event({ id: 2, type: 'death', detail: 'Goblin fell' }),
    ]);
    expect(highlights.some((h) => h.includes('Goblin fell'))).toBe(true);
  });
});
