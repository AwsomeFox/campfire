import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  diffHpFeedback,
  hpFeedbackSnapshot,
  sameHpFeedbackSnapshot,
  withOptimisticHpFeedbackTargets,
  type HpFeedbackSnapshot,
} from '../../src/features/encounters/hpFeedback';

function combatant(partial: Partial<HpFeedbackSnapshot> & Pick<HpFeedbackSnapshot, 'id'>): HpFeedbackSnapshot {
  return {
    hpCurrent: 20,
    hpTemp: 0,
    spCurrent: 0,
    hpBand: null,
    deathState: 'none',
    ...partial,
  };
}

test.describe('encounter HP feedback diff (issue #1907)', () => {
  test('is silent for an initial seed and unchanged refetch', () => {
    const current = [combatant({ id: 1 })];
    expect(diffHpFeedback(new Map(), current)).toEqual([]);
    expect(diffHpFeedback(hpFeedbackSnapshot(current), current)).toEqual([]);
  });

  test('reports exact damage including temporary HP, healing, and temporary HP separately', () => {
    const previous = hpFeedbackSnapshot([combatant({ id: 1, hpCurrent: 20, hpTemp: 3 })]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 14, hpTemp: 3 })])).toEqual([
      { combatantId: 1, kind: 'damage', amount: 6, crit: false },
    ]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 18, hpTemp: 0 })])).toEqual([
      { combatantId: 1, kind: 'damage', amount: 5, crit: false },
    ]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 20, hpTemp: 0 })])).toEqual([]);
    const staminaPrevious = hpFeedbackSnapshot([combatant({ id: 1, hpCurrent: 20, hpTemp: 3, spCurrent: 10 })]);
    expect(diffHpFeedback(staminaPrevious, [combatant({ id: 1, hpCurrent: 20, hpTemp: 3, spCurrent: 5 })])).toEqual([
      { combatantId: 1, kind: 'damage', amount: 5, crit: false },
    ]);
    expect(diffHpFeedback(staminaPrevious, [combatant({ id: 1, hpCurrent: 20, hpTemp: 3, spCurrent: 14 })])).toEqual([
      { combatantId: 1, kind: 'heal', amount: 4 },
    ]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 20, hpTemp: 7 })])).toEqual([
      { combatantId: 1, kind: 'tempHp', amount: 4 },
    ]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 24, hpTemp: 3 })])).toEqual([
      { combatantId: 1, kind: 'heal', amount: 4 },
    ]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 24, hpTemp: 0 })])).toEqual([
      { combatantId: 1, kind: 'heal', amount: 4 },
    ]);
  });

  test('marks only the applying client critical', () => {
    const previous = hpFeedbackSnapshot([combatant({ id: 1 })]);
    expect(diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: 13 })], new Set([1]))).toEqual([
      { combatantId: 1, kind: 'damage', amount: 7, crit: true },
    ]);
  });

  test('keeps a local optimistic target while retaining a concurrent remote update', () => {
    const baseline = hpFeedbackSnapshot([
      combatant({ id: 1, hpCurrent: 20 }),
      combatant({ id: 2, hpCurrent: 20 }),
    ]);
    const merged = withOptimisticHpFeedbackTargets(
      [combatant({ id: 1, hpCurrent: 25 }), combatant({ id: 2, hpCurrent: 15 })],
      [combatant({ id: 1, hpCurrent: 10 }), combatant({ id: 2, hpCurrent: 20 })],
      new Set([1]),
    );
    expect(merged.get(1)?.hpCurrent).toBe(10);
    expect(merged.get(2)?.hpCurrent).toBe(15);
    expect(diffHpFeedback(baseline, [merged.get(2)!])).toEqual([
      { combatantId: 2, kind: 'damage', amount: 5, crit: false },
    ]);
  });

  test('recognizes an own canonical response without accepting an unrelated newer write', () => {
    const before = combatant({ id: 1, hpCurrent: 20 });
    const ownResponse = combatant({ id: 1, hpCurrent: 13 });
    const newerRemoteWrite = combatant({ id: 1, hpCurrent: 8 });
    expect(sameHpFeedbackSnapshot(ownResponse, ownResponse)).toBe(true);
    expect(sameHpFeedbackSnapshot(newerRemoteWrite, ownResponse)).toBe(false);
    expect(diffHpFeedback(hpFeedbackSnapshot([before]), [ownResponse], new Set([1]))).toEqual([
      { combatantId: 1, kind: 'damage', amount: 7, crit: true },
    ]);
  });

  test('uses one-shot down and revive transitions', () => {
    const standing = combatant({ id: 1, hpCurrent: 4 });
    const down = combatant({ id: 1, hpCurrent: 0, deathState: 'dying' });
    const revived = combatant({ id: 1, hpCurrent: 3, deathState: 'none' });
    expect(diffHpFeedback(hpFeedbackSnapshot([standing]), [down]).map(({ kind }) => kind)).toEqual(['down', 'damage']);
    expect(diffHpFeedback(hpFeedbackSnapshot([down]), [revived]).map(({ kind }) => kind)).toEqual(['revive', 'heal']);
    expect(diffHpFeedback(hpFeedbackSnapshot([down]), [down])).toEqual([]);
  });

  test('never derives numeric feedback from a redacted HP band', () => {
    const previous = hpFeedbackSnapshot([combatant({ id: 1, hpCurrent: null, hpTemp: null, hpBand: 'healthy' })]);
    const events = diffHpFeedback(previous, [combatant({ id: 1, hpCurrent: null, hpTemp: null, hpBand: 'bloodied' })]);
    expect(events).toEqual([{ combatantId: 1, kind: 'bandTick', bandDirection: 'hurt' }]);
    expect(events.every((event) => event.amount === undefined)).toBe(true);
  });

  test('uses recovery copy for redacted improvements and does not pair revive with a band tick', () => {
    const critical = combatant({ id: 1, hpCurrent: null, hpTemp: null, hpBand: 'critical' });
    const bloodied = combatant({ id: 1, hpCurrent: null, hpTemp: null, hpBand: 'bloodied' });
    expect(diffHpFeedback(hpFeedbackSnapshot([critical]), [bloodied])).toEqual([
      { combatantId: 1, kind: 'bandTick', bandDirection: 'recover' },
    ]);

    const down = combatant({ id: 1, hpCurrent: null, hpTemp: null, hpBand: 'down', deathState: 'dying' });
    expect(diffHpFeedback(hpFeedbackSnapshot([down]), [bloodied])).toEqual([
      { combatantId: 1, kind: 'revive' },
    ]);
  });

  test('optimistic feedback emits once while protecting concurrent updates and local crits', () => {
    const source = readFileSync(resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx'), 'utf8');
    expect(source).toContain('seedHpFeedbackSnapshot(queryClient.getQueryData<EncounterWithCombatants>(queryKeys.encounter(eid)))');
    expect(source).toContain('const before = ctx.previousCombatant;');
    expect(source).toContain('sameHpFeedbackSnapshot(observed, before)');
    expect(source).toContain('hpFeedbackSnapshotRef.current?.combatants.set(combatant.id, combatant);');
    const mapSource = readFileSync(resolve(__dirname, '../../src/features/encounters/map/BattleMap.tsx'), 'utf8');
    expect(mapSource).toContain('hpFeedbackByCombatant.get(c.id) ?? []');
    expect(mapSource).toContain('className="absolute -translate-x-1/2 -translate-y-1/2 cf-map-focusable"');
    expect(mapSource).not.toContain('cf-map-focusable cf-hp-feedback-anchor');
    expect(mapSource).toContain('className={`cf-hp-feedback-anchor${feedbackClass}`}');
    expect(source).toContain('await Promise.all(applications.map(async ({ combatantId, damage }) => {');
    expect(source).toContain('if (bulkHpFeedbackOperationsRef.current.size > 0) {');
    expect(source).toContain('const pendingTargets = new Set([...bulkHpFeedbackOperationsRef.current.values()]');
    expect(source).toContain('bulkHpFeedbackOperationsRef.current.set(bulkOperationId, feedbackOperation);');
    expect(source).toContain('bulkHpFeedbackOperationsRef.current.delete(bulkOperationId);');
    expect(source).toContain('optimisticQueue.operations.size > 0');
    expect(source).toContain('const feedbackBefore = hpFeedbackSnapshotRef.current?.encounterId === eid');
    expect(source).toContain('appendHpFeedbackEvents(diffHpFeedback(hpFeedbackSnapshot([feedbackBefore]), [optimisticCombatant]))');
    expect(source).toContain('.filter((event) => !pendingTargetIds.has(event.combatantId));');
    expect(source).toContain('const optimisticTargets = [...pendingTargets]');
    expect(source).toContain('const queuedCombatants = queue.encounterId === eid && queue.base && queue.operations.size > 0');
    expect(source).toContain('const feedbackBaseline = hpFeedbackSnapshotRef.current?.encounterId === eid');
    expect(source).toContain('operation.stale.set(combatant.id, combatant);');
    expect(source).toContain('staleObserved && !sameHpFeedbackSnapshot(staleObserved, combatant)');
    expect(source).toContain('!sameHpFeedbackSnapshot(observed, before) && !sameHpFeedbackSnapshot(observed, combatant)');
    expect(source).not.toContain('localCritCombatantIdsRef');
    expect(source).not.toContain('queryClient.setQueryData(queryKeys.encounter(eid), finalEncounter);');
    expect(source).toContain('const snapshot = hpFeedbackSnapshotRef.current;');
    expect(source).toContain('snapshot.combatants.set(combatant.id, combatant);');
    expect(source).toContain('appendHpFeedbackEvents(events);');
    const directCritSuccess = source.slice(source.indexOf('onSuccess: (combatant, vars, ctx) =>'), source.indexOf('onError: (err, _vars, ctx) =>'));
    expect(directCritSuccess).toContain('new Set([vars.combatantId])');
    expect(directCritSuccess).toContain('sameHpFeedbackSnapshot(observed, combatant)');
    expect(directCritSuccess).toContain('appendOrUpgradeHpFeedbackCrit(events);');
    expect(diffHpFeedback(hpFeedbackSnapshot([combatant({ id: 1, hpCurrent: 20 })]), [combatant({ id: 1, hpCurrent: 15 })])).toEqual([
      { combatantId: 1, kind: 'damage', amount: 5, crit: false },
    ]);
    expect(sameHpFeedbackSnapshot(combatant({ id: 1 }), combatant({ id: 1 }))).toBe(true);
    expect(sameHpFeedbackSnapshot(combatant({ id: 1 }), combatant({ id: 1, hpCurrent: 19 }))).toBe(false);
  });

  test('reduced motion keeps feedback badges static', () => {
    const css = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.cf-hp-feedback__item[\s\S]*animation: none !important/);
    expect(css).toContain('top: calc(50% - var(--cf-hp-feedback-offset, 0px));');
  });
});
