/**
 * Group action rolls (issue #1922) — "Run one monster action for every selected identical
 * combatant in one pass." Purely web-orchestrated: this component loops the EXISTING per-actor
 * `POST /encounters/:id/actions/resolve` (`commit: true`) sequentially, the same call an MCP
 * caller could already make one at a time. No new REST endpoint, no MCP change, no resolver
 * policy change — see `groupActionRunnerLogic.ts` for the eligibility/loop/undo-order logic
 * this component wires up to real API calls. That module is named `groupActionRunnerLogic.ts`
 * (not `groupActionRunner.ts`) so it cannot differ from this file's name by case alone — see
 * issue #2070: on a case-insensitive filesystem (macOS/Windows) a same-case-differing pair in
 * one directory makes an extensionless import ambiguous and TypeScript's `.ts`-before-`.tsx`
 * resolution order silently picks the wrong module.
 *
 * DM-only entry point: mounted only when `CombatantActionsList` was given `onUseGroupAction`,
 * which `RunSessionPage` wires with the exact same gating as the single-actor
 * `onUseMonsterAction` (permission for mount) plus `disabledReason` (the sync gate, issue
 * #1746) for the render-disabled state — see that call site.
 */
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import type { ActionResolveResult, ActionSpec, ActionUndoToken, Combatant, UsableAction } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { invalidateEncounter, queryKeys } from '../../lib/query';
import { Btn } from '../../components/ui';
import { GatedControl } from '../../components/GatedControl';
import { useAnnounce } from '../../components/Announcer';
import { legalTargets } from './ActionUseFlow';
import { isDead } from './encounterEndedSummary';
import {
  findGroupActionCandidates,
  runGroupActionSequence,
  undoGroupActionsInReverseOrder,
  type GroupActionCandidate,
  type GroupActionRowResult,
  type GroupActionRunOutcome,
} from './groupActionRunnerLogic';

type Step = 'targets' | 'summary';
type TargetMode = 'shared' | 'perActor';

/** Intersection of every selected candidate's own legal-target ids, so a "shared" pick is
 *  guaranteed legal for the whole group (not just the source actor). */
function sharedLegalTargetIds(combatants: Combatant[], candidates: GroupActionCandidate[]): number[] {
  if (candidates.length === 0) return [];
  let ids: number[] | null = null;
  for (const c of candidates) {
    const legalIds = new Set<number>(legalTargets(combatants, c.combatantId, c.spec.targets.allow).map((t) => t.id));
    ids = ids === null ? [...legalIds] : ids.filter((id) => legalIds.has(id));
  }
  return ids ?? [];
}

export function GroupActionRunner({
  encounterId,
  actorCombatantId,
  actorName,
  actionIndex,
  actionName,
  spec,
  sourceAction,
  combatants,
  applyDisabled = false,
  applyGateReason,
  onDismiss,
}: {
  encounterId: number;
  actorCombatantId: number;
  actorName: string;
  /** The originating actor's own action index — the row the DM actually opened. */
  actionIndex: number;
  actionName: string;
  spec: ActionSpec;
  sourceAction: { name: string; toHit: string; damage: string };
  combatants: Combatant[];
  applyDisabled?: boolean;
  applyGateReason?: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ref.current?.focus({ preventScroll: true });
  }, []);

  // Every OTHER living monster/npc combatant (no linked character sheet) is a POSSIBLE match —
  // `findGroupActionCandidates` narrows this down once each row's own actions have loaded.
  const otherLivingIds = useMemo(
    () =>
      combatants
        .filter((c) => c.id !== actorCombatantId && c.characterId == null && (c.kind === 'monster' || c.kind === 'npc') && !isDead(c))
        .map((c) => c.id),
    [combatants, actorCombatantId],
  );

  const actionQueries = useQueries({
    queries: otherLivingIds.map((id) => ({
      queryKey: [...queryKeys.encounter(encounterId), 'actions', id],
      queryFn: () =>
        api.get<UsableAction[]>(`${API}/encounters/${encounterId}/combatants/${id}/actions`),
      staleTime: 5_000,
    })),
  });
  const loadingCandidates = actionQueries.some((q) => q.isLoading);

  // Recomputed plainly on every render rather than memoized: `useQueries` returns a fresh
  // array reference each render (react-query does not stabilize it across renders), so a
  // dependency-array memoization here would either recompute every render anyway or need a
  // fragile derived key — and roster sizes stay small (≤50, `CombatantCreate.count`'s own
  // cap), so recomputing this cheap filter/match on every render costs nothing measurable.
  const actionsByCombatantId = new Map<number, readonly UsableAction[]>();
  otherLivingIds.forEach((id, i) => {
    const data = actionQueries[i]?.data;
    if (data) actionsByCombatantId.set(id, data);
  });
  const otherCandidates = findGroupActionCandidates({ combatants, actorCombatantId, sourceAction, actionsByCombatantId });
  // The DM opened THIS actor's action row to start the group flow in the first place — "run
  // for all N" means every other matching combatant PLUS this one, not just the others (issue
  // #1922 acceptance: "8 same-statblock goblins ... at most 3 interactions" reads as 8 rolls,
  // not 7). Its own index/spec are already known — no eligibility lookup needed.
  const actorCandidate: GroupActionCandidate = { combatantId: actorCombatantId, combatantName: actorName, actionIndex, actionName, spec };
  const candidates = [actorCandidate, ...otherCandidates];

  // Selection auto-tracks every loaded candidate until the DM manually (de)selects one, at
  // which point it freezes to their explicit choice.
  const [manualSelection, setManualSelection] = useState<Set<number> | null>(null);
  const selectedIds = manualSelection ?? new Set(candidates.map((c) => c.combatantId));
  const toggleCandidate = (id: number) => {
    setManualSelection((prev) => {
      const base = new Set(prev ?? candidates.map((c) => c.combatantId));
      if (base.has(id)) base.delete(id);
      else base.add(id);
      return base;
    });
  };
  const selectedCandidates = candidates.filter((c) => selectedIds.has(c.combatantId));

  const needsTarget = spec.targets.count > 0;
  const maxTargets = spec.targets.count > 0 ? spec.targets.count : 50;

  const [targetMode, setTargetMode] = useState<TargetMode>('shared');
  const [sharedTargetIds, setSharedTargetIds] = useState<number[]>([]);
  const [perActorTargetIds, setPerActorTargetIds] = useState<Map<number, number[]>>(new Map());
  const sharedCandidateTargets = sharedLegalTargetIds(combatants, selectedCandidates);

  const toggleSharedTarget = (id: number) => {
    setSharedTargetIds((prev) => {
      if (prev.includes(id)) return prev.filter((t) => t !== id);
      return prev.length >= maxTargets ? prev : [...prev, id];
    });
  };
  const togglePerActorTarget = (combatantId: number, count: number, id: number) => {
    setPerActorTargetIds((prev) => {
      const next = new Map(prev);
      const current = next.get(combatantId) ?? [];
      const max = count > 0 ? count : 50;
      if (current.includes(id)) next.set(combatantId, current.filter((t) => t !== id));
      else if (current.length < max) next.set(combatantId, [...current, id]);
      return next;
    });
  };

  const [step, setStep] = useState<Step>('targets');
  const [runOutcome, setRunOutcome] = useState<GroupActionRunOutcome | null>(null);
  const [undoneCombatantIds, setUndoneCombatantIds] = useState<Set<number>>(new Set());

  const targetsFor = (c: GroupActionCandidate): number[] =>
    targetMode === 'shared' ? sharedTargetIds : perActorTargetIds.get(c.combatantId) ?? [];

  const canRoll =
    selectedCandidates.length > 0 &&
    (!needsTarget || (targetMode === 'shared' ? sharedTargetIds.length > 0 : selectedCandidates.every((c) => targetsFor(c).length > 0)));

  const run = useMutation({
    mutationFn: () =>
      runGroupActionSequence(selectedCandidates, (c) =>
        api.post<ActionResolveResult>(`${API}/encounters/${encounterId}/actions/resolve`, {
          actorCombatantId: c.combatantId,
          actionIndex: c.actionIndex,
          actionName: c.actionName,
          expectedSpec: c.spec,
          targetIds: targetsFor(c),
          commit: true,
        }),
      ),
    onSuccess: (outcome) => {
      setRunOutcome(outcome);
      setUndoneCombatantIds(new Set());
      setStep('summary');
      void invalidateEncounter(queryClient, encounterId);
      const appliedCount = outcome.results.filter((r) => r.status === 'applied').length;
      announce(
        t('encounters.groupAction.announceComplete', {
          defaultValue: '{{applied}} of {{total}} applied.',
          applied: appliedCount,
          total: outcome.results.length,
        }),
      );
    },
  });

  const undoRow = useMutation({
    mutationFn: (token: ActionUndoToken) => api.post(`${API}/encounters/${encounterId}/actions/undo`, token),
    onSuccess: (_data, token) => {
      setUndoneCombatantIds((prev) => new Set(prev).add(token.actorCombatantId));
      void invalidateEncounter(queryClient, encounterId);
    },
  });

  const undoAll = useMutation({
    mutationFn: async () => {
      const remaining = (runOutcome?.results ?? [])
        .filter((r): r is GroupActionRowResult & { undoToken: ActionUndoToken } => r.status === 'applied' && !!r.undoToken && !undoneCombatantIds.has(r.combatantId))
        .map((r) => r.undoToken);
      return undoGroupActionsInReverseOrder(remaining, async (token) => {
        await api.post(`${API}/encounters/${encounterId}/actions/undo`, token);
        setUndoneCombatantIds((prev) => new Set(prev).add(token.actorCombatantId));
      });
    },
    onSuccess: () => {
      void invalidateEncounter(queryClient, encounterId);
    },
  });

  const hasUndoableRows = (runOutcome?.results ?? []).some((r) => r.status === 'applied' && r.undoToken && !undoneCombatantIds.has(r.combatantId));

  const statusLabel = (row: GroupActionRowResult): string => {
    switch (row.status) {
      case 'applied':
        return t('encounters.groupAction.status.applied', { defaultValue: 'Applied' });
      case 'skipped':
        return t('encounters.groupAction.status.skipped', { defaultValue: 'Skipped — no action left' });
      case 'failed':
        return t('encounters.groupAction.status.failed', { defaultValue: 'Failed' });
      default:
        return t('encounters.groupAction.status.notRun', { defaultValue: 'Not run' });
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="cf-inset"
      role="region"
      aria-label={t('encounters.groupAction.regionLabel', { defaultValue: 'Run {{actionName}} for the group', actionName }) as string}
      data-testid="group-action-runner"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', marginBottom: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>
          {t('encounters.groupAction.heading', { defaultValue: '{{actorName}} · {{actionName}} · group', actorName, actionName })}
        </span>
        <button
          type="button"
          className="btn btn-ghost cf-target-44"
          disabled={run.isPending}
          onClick={onDismiss}
          style={{ marginLeft: 'auto' }}
          aria-label={t('encounters.groupAction.dismissLabel', { defaultValue: 'Cancel group action' }) as string}
        >
          {t('encounters.groupAction.cancel', { defaultValue: 'Cancel' })}
        </button>
      </div>

      {step === 'targets' && (
        <>
          {loadingCandidates && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }} data-testid="group-action-loading">
              {t('encounters.groupAction.loadingCandidates', { defaultValue: 'Checking the roster for matching combatants…' })}
            </p>
          )}
          {!loadingCandidates && otherCandidates.length === 0 && (
            <p className="text-muted" style={{ fontSize: 12, margin: 0 }} data-testid="group-action-empty">
              {t('encounters.groupAction.noCandidates', { defaultValue: 'No other living combatants match this action.' })}
            </p>
          )}
          {!loadingCandidates && (
            <>
              <div>
                <span className="card-kicker" style={{ marginBottom: 6, display: 'block' }}>
                  {t('encounters.groupAction.runForAllCount', { defaultValue: 'Run for all {{count}}', count: selectedCandidates.length })}
                </span>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="group-action-candidates">
                  {candidates.map((c) => (
                    <button
                      key={c.combatantId}
                      type="button"
                      className={selectedIds.has(c.combatantId) ? 'tag tag-accent' : 'tag tag-neutral'}
                      aria-pressed={selectedIds.has(c.combatantId)}
                      onClick={() => toggleCandidate(c.combatantId)}
                      style={{ minHeight: 44, minWidth: 44, cursor: 'pointer', border: 0 }}
                    >
                      {c.combatantName}
                    </button>
                  ))}
                </div>
              </div>

              {needsTarget && (
                <div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <button
                      type="button"
                      className={targetMode === 'shared' ? 'btn btn-primary' : 'btn btn-ghost'}
                      onClick={() => setTargetMode('shared')}
                    >
                      {t('encounters.groupAction.targetShared', { defaultValue: 'Shared target' })}
                    </button>
                    <button
                      type="button"
                      className={targetMode === 'perActor' ? 'btn btn-primary' : 'btn btn-ghost'}
                      onClick={() => setTargetMode('perActor')}
                    >
                      {t('encounters.groupAction.targetPerActor', { defaultValue: 'Target individually' })}
                    </button>
                  </div>

                  {targetMode === 'shared' && (
                    <div>
                      <span className="card-kicker" style={{ marginBottom: 6, display: 'block' }}>
                        {t('encounters.groupAction.pickTargets', {
                          defaultValue: 'Pick target(s) ({{selected}}/{{max}})',
                          selected: sharedTargetIds.length,
                          max: spec.targets.count || '∞',
                        })}
                      </span>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="group-action-shared-targets">
                        {sharedCandidateTargets.map((id) => {
                          const target = combatants.find((c) => c.id === id);
                          if (!target) return null;
                          return (
                            <button
                              key={id}
                              type="button"
                              className={sharedTargetIds.includes(id) ? 'tag tag-accent' : 'tag tag-neutral'}
                              aria-pressed={sharedTargetIds.includes(id)}
                              onClick={() => toggleSharedTarget(id)}
                              style={{ minHeight: 44, minWidth: 44, cursor: 'pointer', border: 0 }}
                            >
                              {target.name}
                            </button>
                          );
                        })}
                        {sharedCandidateTargets.length === 0 && (
                          <span className="text-muted" style={{ fontSize: 12 }}>
                            {t('encounters.actionFlow.noTargets')}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {targetMode === 'perActor' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="group-action-per-actor-targets">
                      {selectedCandidates.map((c) => {
                        const legal = legalTargets(combatants, c.combatantId, c.spec.targets.allow);
                        const chosen = perActorTargetIds.get(c.combatantId) ?? [];
                        return (
                          <div key={c.combatantId} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, minWidth: 90 }}>{c.combatantName}</span>
                            {legal.map((target) => (
                              <button
                                key={target.id}
                                type="button"
                                className={chosen.includes(target.id) ? 'tag tag-accent' : 'tag tag-neutral'}
                                aria-pressed={chosen.includes(target.id)}
                                onClick={() => togglePerActorTarget(c.combatantId, c.spec.targets.count, target.id)}
                                style={{ minHeight: 44, minWidth: 44, cursor: 'pointer', border: 0 }}
                              >
                                {target.name}
                              </button>
                            ))}
                            {legal.length === 0 && (
                              <span className="text-muted" style={{ fontSize: 12 }}>
                                {t('encounters.actionFlow.noTargets')}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              <GatedControl reason={run.isPending ? undefined : applyGateReason}>
                <Btn
                  data-testid="group-action-roll"
                  disabled={applyDisabled || applyGateReason != null || !canRoll || run.isPending}
                  busy={run.isPending}
                  onClick={() => run.mutate()}
                >
                  {run.isPending
                    ? t('encounters.groupAction.rolling', { defaultValue: 'Rolling…' })
                    : t('encounters.groupAction.roll', { defaultValue: 'Roll for group' })}
                </Btn>
              </GatedControl>
            </>
          )}
        </>
      )}

      {step === 'summary' && runOutcome && (
        <>
          {runOutcome.stoppedEarly && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0, color: 'var(--color-warning, #d97706)' }} data-testid="group-action-stopped-early">
              {t('encounters.groupAction.stoppedEarly', {
                defaultValue: 'Stopped after a failure — {{applied}} applied, {{notRun}} not run.',
                applied: runOutcome.results.filter((r) => r.status === 'applied').length,
                notRun: runOutcome.results.filter((r) => r.status === 'not-run' || r.status === 'failed').length,
              })}
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="group-action-results">
            {runOutcome.results.map((row) => (
              <div key={row.combatantId} className="cf-inset" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }} data-testid={`group-action-row-${row.combatantId}`}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5 }}>
                    <strong>{row.combatantName}</strong>: {row.status === 'applied' ? row.summaryText : statusLabel(row)}
                  </div>
                </div>
                {row.status === 'applied' && row.undoToken && (
                  undoneCombatantIds.has(row.combatantId) ? (
                    <span className="text-muted" style={{ fontSize: 11.5 }}>
                      {t('encounters.groupAction.undone', { defaultValue: 'Undone' })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-testid={`group-action-undo-${row.combatantId}`}
                      disabled={undoRow.isPending || undoAll.isPending}
                      onClick={() => row.undoToken && undoRow.mutate(row.undoToken)}
                    >
                      {t('encounters.groupAction.undo', { defaultValue: 'Undo' })}
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn
              data-testid="group-action-undo-all"
              disabled={!hasUndoableRows || undoAll.isPending || undoRow.isPending}
              busy={undoAll.isPending}
              onClick={() => undoAll.mutate()}
            >
              {undoAll.isPending
                ? t('encounters.groupAction.undoingAll', { defaultValue: 'Undoing…' })
                : t('encounters.groupAction.undoAll', { defaultValue: 'Undo all' })}
            </Btn>
            <button type="button" className="btn btn-ghost" data-testid="group-action-close" onClick={onDismiss}>
              {t('encounters.groupAction.close', { defaultValue: 'Close' })}
            </button>
          </div>
          {undoAll.data?.failed && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0, color: 'var(--color-warning, #d97706)' }} data-testid="group-action-undo-all-failed">
              {t('encounters.groupAction.undoAllFailed', { defaultValue: 'Some undos failed — reload to check the encounter state.' })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
