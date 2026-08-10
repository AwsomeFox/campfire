import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { legalTargets } from '../../src/features/encounters/ActionUseFlow';
import { MAP_PING_TAP_SLOP_PX, mapPingTapExceededSlop } from '../../src/features/encounters/mapPingTap';
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
  expect(source).toContain('onBackToTargets(actionToken);');
  expect(source).toContain('onPreview(resolveActionToken);');
  expect(source).toContain('onPreviewStart(resolveActionToken);');
  expect(source).toContain('onPreviewError(resolveActionToken);');
});

test('movable target touch jitter stays a target tap inside the shared CSS-pixel slop', async () => {
  expect(mapPingTapExceededSlop({ clientX: 100, clientY: 200 }, 100 + MAP_PING_TAP_SLOP_PX - 1, 200)).toBe(false);
  expect(mapPingTapExceededSlop({ clientX: 100, clientY: 200 }, 100 + MAP_PING_TAP_SLOP_PX + 1, 200)).toBe(true);
  const mapSource = await readFile(resolve(process.cwd(), 'src/features/encounters/map/BattleMap.tsx'), 'utf8');
  expect(mapSource).toContain('mapPingTapExceededSlop(gesture, e.clientX, e.clientY)');
});

test('target row convenience ignores label and summary interactions', async () => {
  const rosterSource = await readFile(resolve(process.cwd(), 'src/features/encounters/combat/CombatantRow.tsx'), 'utf8');
  expect(rosterSource).toContain('button, input, select, textarea, a, label, summary, [role="button"], [data-combatant-statblock], [data-combatant-detail]');
  expect(rosterSource).toContain('{statblock && <div data-combatant-statblock>{statblock}</div>}');
  expect(rosterSource).toContain('<div data-combatant-detail>');
  // Issue #1992 added an onBlur handler to this <details> (save-on-blur for the
  // statblock editor's CAS guard), so the tag itself now spans several lines — matched
  // by a regex rather than the old single-line literal, but still pinning the same
  // invariant: this wrapper still carries `data-combatant-detail`.
  expect(rosterSource).toMatch(/<details\s+className="mt-2"\s+data-combatant-detail/);
});

test('action impact flash replaces its previous expiry and cleans up on unmount', async () => {
  const sessionSource = await readFile(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
  expect(sessionSource).toContain('const actionImpactTimerRef = useRef<number | null>(null);');
  expect(sessionSource).toContain('if (actionImpactTimerRef.current != null) window.clearTimeout(actionImpactTimerRef.current);');
  expect(sessionSource).toContain('actionImpactTimerRef.current = window.setTimeout(() => {');
});

test('legal target affordances support repeated pointer and keyboard selection', async () => {
  const [mapSource, rosterSource] = await Promise.all([
    readFile(resolve(process.cwd(), 'src/features/encounters/map/BattleMap.tsx'), 'utf8'),
    readFile(resolve(process.cwd(), 'src/features/encounters/combat/CombatantRow.tsx'), 'utf8'),
  ]);

  expect(mapSource).toContain("const targetClickable = legalTarget && targetAvailable && !targeting?.declared && tool === 'move' && !viewportPan && !movable;");
  expect(mapSource).toContain('tabIndex={movable || targetClickable ? 0 : -1}');
  expect(mapSource).toContain("e.key === 'Enter' || e.key === ' '");
  expect(mapSource).toContain('if (movable) onTokenKeyDown(e, c);');
  expect(mapSource).toContain('if (movable) setSelectedTokenId(c.id);');
  expect(mapSource).toContain('targetGestureRef.current = { tokenId: gesture.tokenId, moved: gesture.moved };');
  expect(mapSource).toContain('const targetAvailable = selectedTarget || !targeting?.atCapacity;');
  expect(mapSource).toContain('&& ((targeting?.selectedIds.includes(c.id) ?? false) || !targeting?.atCapacity);');
  // Issue #1917 stage 3: the token wrapper is now `MapTokenSlot`, a real component, so this
  // reaches the DOM through its `ariaDisabled` prop rather than JSX's `aria-disabled=` directly.
  expect(mapSource).toContain('ariaDisabled={legalTarget && !targetAvailable ? true : undefined}');
  expect(mapSource).toContain('if (targetClickable && e.isPrimary)');
  expect(mapSource).toContain('clientX: e.clientX, clientY: e.clientY');
  expect(mapSource).toContain('strokeWidth={2}');
  expect(mapSource).not.toContain('event.detail === 1');
  expect(rosterSource).toContain('data-testid={`combatant-target-toggle-${combatant.id}`}');
  expect(rosterSource).toContain('aria-pressed={targeting.selected}');
  expect(rosterSource).toContain('disabled={targeting.declared || targetSelectionUnavailable}');
});

test('target affordances disable unselected targets at the action target limit', async () => {
  const sessionSource = await readFile(resolve(process.cwd(), 'src/features/encounters/RunSessionPage.tsx'), 'utf8');
  expect(sessionSource).toContain('const actionTargetsAtCapacity = !!pendingActionUse');
  expect(sessionSource).toContain('atCapacity: actionTargetsAtCapacity');
});
