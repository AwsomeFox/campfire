import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const source = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');

test('serializes duplicate combatant clicks and reconciles ambiguous outcomes', () => {
  expect(source).toContain('const pendingDuplicateCombatantIds = useRef(new Set<number>());');
  expect(source).toContain('if (riskyBlocked || reconcileBlocks || pendingDuplicateCombatantIds.current.has(combatant.id)) return;');
  expect(source).toContain('pendingDuplicateCombatantIds.current.add(combatant.id);');
  expect(source.indexOf('pendingDuplicateCombatantIds.current.add(combatant.id);')).toBeLessThan(source.indexOf('duplicateCombatant.mutate({'));
  expect(source).toContain('pendingDuplicateCombatantIds.current.delete(combatantId);');
  expect(source).toContain('if (isAmbiguousOutcome(err)) enterReconciling();');
  expect(source).toContain('initiativeGroup: combatant.initiativeGroup ?? undefined,');
});
