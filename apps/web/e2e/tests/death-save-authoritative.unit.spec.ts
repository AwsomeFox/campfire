import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const source = readFileSync(resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx'), 'utf8');
const runSessionSource = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');

test('TurnWorkspace keeps the server-authoritative death save single-flight', () => {
  expect(source).toContain('deathSavePending?: boolean');
  expect(source).toContain('disabled={controlsDisabled || deathSavePending || !onRollDeathSave}');
  expect(source).not.toContain('Math.random()');
  expect(source).not.toContain('onPatchCombatant');
});

test('death-save requests carry one retry-safe action key', () => {
  expect(runSessionSource).toContain('const deathSaveRoll = useKeyedMutation({');
  expect(runSessionSource).toContain('api.post(`${API}/encounters/${eid}/combatants/${combatantId}/death-save`, { idempotencyKey })');
});

test('a death-save request only disables its own combatant', () => {
  expect(runSessionSource).toContain('markCombatantPending(combatantId, true);');
  expect(runSessionSource).toContain('markCombatantPending(combatantId, false);');
  expect(runSessionSource).toContain('busy={pendingCombatantIds.has(c.id) || reconcileBlocks}');
  expect(runSessionSource).not.toContain('busy={pendingCombatantIds.has(c.id) || deathSaveRoll.isPending || reconcileBlocks}');
});

test('an ambiguous death-save outcome reconciles before allowing another roll', () => {
  expect(runSessionSource).toContain('if (isAmbiguousOutcome(err)) enterReconciling();');
  expect(runSessionSource).toContain('busy={pendingCombatantIds.has(c.id) || reconcileBlocks}');
  expect(runSessionSource).toContain('deathSavePending={currentCombatantId != null && (pendingCombatantIds.has(currentCombatantId) || reconcileBlocks)}');
});

test('terminal death-save states retain pips without exposing an invalid roll action', () => {
  expect(runSessionSource).toContain("canRoll={combatant.deathState === 'dying'}");
  expect(runSessionSource).toContain('{canEditPermission && canRoll && (');
});
