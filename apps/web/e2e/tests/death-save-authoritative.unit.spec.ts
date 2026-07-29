import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const source = readFileSync(resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'), 'utf8');

test('TurnWorkspace keeps the server-authoritative death save single-flight', () => {
  expect(source).toContain('deathSavePending?: boolean');
  expect(source).toContain('disabled={controlsDisabled || deathSavePending || !onRollDeathSave}');
  expect(source).not.toContain('Math.random()');
  expect(source).not.toContain('onPatchCombatant');
});
