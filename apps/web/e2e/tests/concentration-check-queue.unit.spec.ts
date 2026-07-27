import { test, expect } from '@playwright/test';
import { appendConcentrationCheck, dequeueConcentrationCheck } from '../../src/features/encounters/concentrationCheckQueue';

const first = { combatantId: 1, name: 'A', damage: 8, dc: 10 };
const second = { combatantId: 2, name: 'B', damage: 25, dc: 13 };

test.describe('concentration check queue', () => {
  test('appends prompts in damage-response order', () => expect(appendConcentrationCheck([first], second)).toEqual([first, second]));
  test('dequeues only after pass or successful clear', () => expect(dequeueConcentrationCheck([first, second])).toEqual([second]));
  test('does not mutate the queue while dequeuing', () => {
    const queue = [first, second];
    expect(dequeueConcentrationCheck(queue)).toEqual([second]);
    expect(queue).toEqual([first, second]);
  });
});
