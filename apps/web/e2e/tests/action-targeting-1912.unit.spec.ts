import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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

test('targeting lifecycle contracts keep preview and Back transitions explicit', async () => {
  const source = await readFile(resolve(process.cwd(), 'src/features/encounters/ActionUseFlow.tsx'), 'utf8');
  expect(source).toContain('onBackToTargets();');
  expect(source).toContain('onPreview();');
});

test('legal target affordances support repeated pointer and keyboard selection', async () => {
  const [mapSource, rosterSource] = await Promise.all([
    readFile(resolve(process.cwd(), 'src/features/encounters/map/BattleMap.tsx'), 'utf8'),
    readFile(resolve(process.cwd(), 'src/features/encounters/combat/CombatantRow.tsx'), 'utf8'),
  ]);

  expect(mapSource).toContain("const targetClickable = legalTarget && tool === 'move' && !viewportPan && !movable;");
  expect(mapSource).toContain('tabIndex={movable || targetClickable ? 0 : -1}');
  expect(mapSource).toContain("e.key === 'Enter' || e.key === ' '");
  expect(mapSource).toContain('if (movable) onTokenKeyDown(e, c);');
  expect(mapSource).toContain('targetGestureRef.current = { tokenId: gesture.tokenId, moved: gesture.moved };');
  expect(mapSource).toContain('strokeWidth={2}');
  expect(mapSource).not.toContain('event.detail === 1');
  expect(rosterSource).toContain('data-testid={`combatant-target-toggle-${combatant.id}`}');
  expect(rosterSource).toContain('aria-pressed={targeting.selected}');
});
