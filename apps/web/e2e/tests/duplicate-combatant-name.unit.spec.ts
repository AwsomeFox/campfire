import { expect, test } from '@playwright/test';
import { duplicateCombatantName } from '../../src/features/encounters/duplicateCombatantName';

test('numbers duplicate combatant names from the roster maximum', () => {
  expect(duplicateCombatantName('Goblin', ['Goblin'])).toBe('Goblin 2');
  expect(duplicateCombatantName('Goblin', ['Goblin', 'Goblin 3', 'Goblin 2'])).toBe('Goblin 4');
  expect(duplicateCombatantName('Goblin 12', ['Goblin 12', 'Goblin 3'])).toBe('Goblin 13');
  expect(duplicateCombatantName('x'.repeat(120), [])).toHaveLength(120);
});
