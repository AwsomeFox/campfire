import { expect, test } from '@playwright/test';
import {
  consumeEncounterAftermathRecap,
  encounterAftermathRecapStorageKey,
  storeEncounterAftermathRecap,
} from '../../src/features/encounters/encounterAftermathHandoff';

test.describe('encounter aftermath handoff storage (issue #473)', () => {
  test('stores and consumes a recap draft once', () => {
    const key = encounterAftermathRecapStorageKey(4, 99);
    sessionStorage.removeItem(key);
    storeEncounterAftermathRecap(4, 99, '## Recap\n- Fight happened');
    expect(sessionStorage.getItem(key)).toContain('Fight happened');
    expect(consumeEncounterAftermathRecap(4, 99)).toContain('Fight happened');
    expect(consumeEncounterAftermathRecap(4, 99)).toBeNull();
  });
});
