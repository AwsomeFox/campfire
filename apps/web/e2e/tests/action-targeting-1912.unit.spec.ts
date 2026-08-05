import { expect, test } from '@playwright/test';
import { legalTargets } from '../../src/features/encounters/ActionUseFlow';
import type { Combatant } from '@campfire/schema';

test('legal targets are shared for player characters and monster actors', () => {
  const combatants = [
    { id: 1, kind: 'character', name: 'Nyx' },
    { id: 2, kind: 'monster', name: 'Bandit' },
    { id: 3, kind: 'npc', name: 'Guide' },
  ] as unknown as Combatant[];

  expect(legalTargets(combatants, 1, 'enemy').map((combatant) => combatant.id)).toEqual([2, 3]);
  expect(legalTargets(combatants, 2, 'enemy').map((combatant) => combatant.id)).toEqual([1]);
});
