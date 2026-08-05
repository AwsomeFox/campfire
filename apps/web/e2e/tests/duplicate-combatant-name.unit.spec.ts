import { expect, test } from '@playwright/test';
import { duplicateCombatantName } from '../../src/features/encounters/duplicateCombatantName';

test('numbers duplicate combatant names from the roster maximum', () => {
  expect(duplicateCombatantName('Goblin', ['Goblin'])).toBe('Goblin 2');
  expect(duplicateCombatantName('Goblin', ['Goblin', 'Goblin 3', 'Goblin 2'])).toBe('Goblin 4');
  expect(duplicateCombatantName('Goblin 12', ['Goblin 12', 'Goblin 3'])).toBe('Goblin 13');
  const longName = 'x'.repeat(120);
  const longRoster = [longName];
  for (let number = 2; number <= 11; number += 1) {
    const duplicate = duplicateCombatantName(longName, longRoster);
    expect(duplicate).toMatch(new RegExp(` ${number}$`));
    expect(duplicate).toHaveLength(120);
    longRoster.push(duplicate);
  }
});
