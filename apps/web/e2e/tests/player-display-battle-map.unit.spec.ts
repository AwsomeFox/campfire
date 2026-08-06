/**
 * Player Display battle-map projection (issue #484).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AoeTemplate, Combatant, EncounterWithCombatants } from '@campfire/schema';
import { safeEncounterForCast } from '../../src/features/screen/playerSafe';

const PLAYER_DISPLAY_PAGE = resolve(__dirname, '../../src/features/screen/PlayerDisplayPage.tsx');
const BATTLE_MAP = resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx');

function combatant(partial: Partial<Combatant> & Pick<Combatant, 'id' | 'name'>): Combatant {
  return {
    kind: 'monster',
    initiative: 10,
    hpCurrent: 10,
    hpMax: 10,
    hpBand: null,
    conditions: [],
    tokenX: null,
    tokenY: null,
    tokenSize: 'medium',
    tokenHiddenByFog: false,
    characterId: null,
    npcId: null,
    monsterId: null,
    ac: null,
    ...partial,
  } as Combatant;
}

function encounter(partial: Partial<EncounterWithCombatants>): EncounterWithCombatants {
  return {
    id: 1,
    campaignId: 1,
    name: 'Fight',
    status: 'running',
    round: 1,
    currentCombatantId: null,
    turnPhase: 'turn',
    mapAttachmentId: 9,
    updatedAt: '2026-01-01T00:00:00.000Z',
    combatants: [],
    monsterHpDisplay: 'band',
    fog: null,
    aoe: [],
    ...partial,
  } as EncounterWithCombatants;
}

test.describe('Player Display battle map (issue #484)', () => {
  test('PlayerDisplayPage mounts BattleMap in cast projection on the map scene', () => {
    const source = readFileSync(PLAYER_DISPLAY_PAGE, 'utf8');
    expect(source).toContain("projection=\"cast\"");
    expect(source).toContain('safeEncounterForCast');
    expect(source).toContain("from '../encounters/RunSessionPage'");
  });

  test('BattleMap exports a cast projection mode for the table-facing surface', () => {
    const source = readFileSync(BATTLE_MAP, 'utf8');
    expect(source).toContain("export function BattleMap");
    expect(source).toContain("projection?: 'session' | 'cast'");
    expect(source).toContain("data-testid={isCast ? 'cf-cast-battle-map' : 'battle-map'}");
  });

  test('safeEncounterForCast redacts fog-hidden tokens and unrevealed AoE', () => {
    const fog = { enabled: true, revealed: [{ x: 60, y: 60, w: 40, h: 40 }] };
    const aoe: AoeTemplate[] = [
      { id: 'dark', shape: 'circle', x: 10, y: 10, sizeFt: 20, angleDeg: 0, color: null, declaredByUserId: null },
      { id: 'lit', shape: 'circle', x: 80, y: 80, sizeFt: 20, angleDeg: 0, color: null, declaredByUserId: null },
    ];
    const enc = encounter({
      fog,
      aoe,
      combatants: [
        combatant({ id: 1, name: 'Hidden', tokenX: 10, tokenY: 10 }),
        combatant({
          id: 2,
          name: 'Visible',
          tokenX: 80,
          tokenY: 80,
          hpCurrent: 75,
          hpMax: 100,
          turnState: { concentration: 'Bless' } as Combatant['turnState'],
        }),
      ],
    });

    const safe = safeEncounterForCast(enc);
    expect(safe.combatants.find((c) => c.id === 1)).toMatchObject({
      tokenX: null,
      tokenY: null,
      tokenHiddenByFog: true,
    });
    expect(safe.combatants.find((c) => c.id === 2)).toMatchObject({
      tokenX: 80,
      hpCurrent: null,
      hpMax: null,
      hpBand: 'healthy',
      turnState: { concentration: null, used: {}, movementUsedFt: 0, pendingConcentrationChecks: [], delaying: false, readied: null },
    });
    expect(safe.aoe?.map((t) => t.id)).toEqual(['lit']);
  });
});
