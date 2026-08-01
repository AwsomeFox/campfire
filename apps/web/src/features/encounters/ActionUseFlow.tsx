import { useTranslation } from 'react-i18next';
/**
 * Structured action Use flow (issue #414) — pick legal targets, resolve to a preview,
 * commit atomically (or hand off to the DM under dm-confirmed / player-declares policy),
 * and offer undo. Player-safe preview text is shown before commit; DM-only mechanics stay
 * out of the player-facing lines.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ActionApplyPolicy,
  ActionResolveResult,
  ActionSpec,
  ActionTargetAllow,
  ActionUndoToken,
  Combatant,
} from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { invalidateEncounter } from '../../lib/query';
import { RollContextMenu } from '../../components/RollContextMenu';
import { Btn } from '../../components/ui';
import { useAnnounce } from '../../components/Announcer';

type Step = 'targets' | 'preview';

function isEnemyTarget(actor: Combatant, target: Combatant): boolean {
  return actor.kind === 'character'
    ? target.kind === 'monster' || target.kind === 'npc'
    : target.kind === 'character';
}

function isAllyTarget(actor: Combatant, target: Combatant): boolean {
  return actor.kind === 'character'
    ? target.kind === 'character'
    : target.kind === 'monster' || target.kind === 'npc';
}

function legalTargets(combatants: Combatant[], actorId: number, allow: ActionTargetAllow): Combatant[] {
  const actor = combatants.find((c) => c.id === actorId);
  if (!actor) return [];
  if (allow === 'self') return combatants.filter((c) => c.id === actorId);
  const others = combatants.filter((c) => c.id !== actorId);
  if (allow === 'enemy') return others.filter((c) => isEnemyTarget(actor, c));
  if (allow === 'ally') return others.filter((c) => isAllyTarget(actor, c));
  return others;
}

export function ActionUsePanel({
  encounterId,
  actorCombatantId,
  actorName,
  actionIndex,
  actionName,
  spec,
  combatants,
  isDm,
  applyDisabled = false,
  onDismiss,
  onApplied,
  onError,
}: {
  encounterId: number;
  actorCombatantId: number;
  actorName: string;
  actionIndex: number;
  actionName: string;
  spec: ActionSpec;
  combatants: Combatant[];
  isDm: boolean;
  applyDisabled?: boolean;
  onDismiss: () => void;
  onApplied: (undoToken: ActionUndoToken, policy: ActionApplyPolicy, sourceEncounterId: number) => void;
  onError: (msg: string | null) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('targets');
  const [targetIds, setTargetIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<ActionResolveResult | null>(null);
  const [commitSubmitted, setCommitSubmitted] = useState(false);
  const [isUnconfirmed, setIsUnconfirmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ref.current?.focus({ preventScroll: true });
    announce(`${actionName} ready. Pick targets or preview.`);
  }, [actionName, announce]);

  const candidates = useMemo(
    () => legalTargets(combatants, actorCombatantId, spec.targets.allow),
    [combatants, actorCombatantId, spec.targets.allow],
  );
  const needsTarget = spec.targets.count > 0;

  const resolvePreview = useMutation({
    mutationFn: (rollMode?: 'normal' | 'advantage' | 'disadvantage' | 'crit') =>
      api.post<ActionResolveResult>(`${API}/encounters/${encounterId}/actions/resolve`, {
        actorCombatantId,
        actionIndex,
        targetIds,
        commit: false,
        rollMode,
      }),
    onMutate: () => onError(null),
    onSuccess: (res) => {
      setPreview(res);
      setStep('preview');
      announce(res.resolution.playerSummary);
    },
    onError: (err) => onError(translateApiError(err, t, { fallbackKey: 'encounters.errors.resolveAction' })),
  });

  const commit = useMutation({
    // Issue #1451: apply takes the chainId returned by resolve — a lookup key only. The
    // server re-reads the exact resolution it computed and persisted at resolve time rather
    // than trusting anything the client echoes back.
    mutationFn: ({ chainId, sourceEncounterId }: { chainId: string; sourceEncounterId: number }) =>
      api.post<{ undoToken: ActionUndoToken }>(`${API}/encounters/${sourceEncounterId}/actions/apply`, { chainId }).then((r) => ({
        ...preview!,
        applied: true,
        undoToken: r.undoToken,
        sourceEncounterId,
      })),
    onMutate: () => {
      setCommitSubmitted(true);
      setIsUnconfirmed(false);
      onError(null);
    },
    onSuccess: (res) => {
      if (res.undoToken) onApplied(res.undoToken, res.policy, res.sourceEncounterId);
      announce(`${actionName} applied.`);
      onDismiss();
    },
    onError: (err) => {
      const is4xx = err instanceof ApiError && err.status >= 400 && err.status < 500;
      if (is4xx) {
        setCommitSubmitted(false);
        setIsUnconfirmed(false);
        onError(translateApiError(err, t, { fallbackKey: 'encounters.errors.applyAction' }));
      } else {
        // Issue #1474: Ambiguous network or server error — lock the button, surface unconfirmed outcome,
        // and refresh the encounter state rather than permitting duplicate retry dispatches.
        setIsUnconfirmed(true);
        void invalidateEncounter(queryClient, encounterId);
        onError(
          t('encounters.errors.applyUnconfirmed', {
            defaultValue: 'Outcome unconfirmed due to a network error. Encounter state refreshed.',
          }),
        );
      }
    },
  });

  function toggleTarget(id: number) {
    setTargetIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      const max = spec.targets.count > 0 ? spec.targets.count : 50;
      if (prev.length >= max) return prev;
      return [...prev, id];
    });
  }

  const canPreview = !needsTarget || targetIds.length > 0;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="cf-inset"
      role="region"
      aria-label={`Use ${actionName}`}
      data-testid="action-use-panel"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', marginBottom: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{actorName} · {actionName}</span>
        <span className="text-muted" style={{ fontSize: 11.5 }}>{spec.mode} · {spec.cost.count > 0 ? `${spec.cost.count} ${spec.cost.slot}` : 'free'}</span>
        <button
          type="button"
          className="btn btn-ghost cf-target-44"
          disabled={commit.isPending || commitSubmitted || isUnconfirmed}
          onClick={onDismiss}
          style={{ marginLeft: 'auto' }}
          aria-label="Cancel action use"
        >
          Cancel
        </button>
      </div>

      {step === 'targets' && (
        <>
          {spec.range.range && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
              Range: {spec.range.range}{spec.range.size ? ` · ${spec.range.shape || 'area'} ${spec.range.size}` : ''}
            </p>
          )}
          {needsTarget && (
            <div>
              <span className="card-kicker" style={{ marginBottom: 6, display: 'block' }}>
                Pick target{spec.targets.count === 1 ? '' : 's'} ({targetIds.length}/{spec.targets.count || '∞'})
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} data-testid="action-use-targets">
                {candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={targetIds.includes(c.id) ? 'tag tag-accent' : 'tag tag-neutral'}
                    aria-pressed={targetIds.includes(c.id)}
                    onClick={() => toggleTarget(c.id)}
                    style={{ minHeight: 44, minWidth: 44, cursor: 'pointer', border: 0 }}
                  >
                    {c.name}
                  </button>
                ))}
                {candidates.length === 0 && <span className="text-muted" style={{ fontSize: 12 }}>No legal targets.</span>}
              </div>
            </div>
          )}
          <RollContextMenu
            className="btn btn-primary"
            data-testid="action-use-preview"
            disabled={!canPreview || resolvePreview.isPending}
            onRoll={(mode) => resolvePreview.mutate(mode)}
          >
            {resolvePreview.isPending ? 'Resolving…' : 'Preview'}
          </RollContextMenu>
        </>
      )}

      {step === 'preview' && preview && (
        <>
          <div data-testid="action-use-preview-text" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
            <p style={{ margin: '0 0 6px' }}>{preview.resolution.playerSummary}</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {preview.resolution.targets.map((t) => (
                <li key={t.combatantId}>
                  <strong>{t.name}</strong>: {t.playerText}
                </li>
              ))}
            </ul>
          </div>
          {preview.policy === 'dm-confirmed' && !isDm && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
              Your DM will apply the consequences — this is a declaration only.
            </p>
          )}
          {preview.policy === 'player-declares' && !isDm && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
              Declared — waiting for the DM to apply.
            </p>
          )}
          {isUnconfirmed && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <p className="text-muted" style={{ fontSize: 11.5, margin: 0, color: 'var(--color-warning, #d97706)' }} data-testid="action-use-unconfirmed-text">
                {t('encounters.errors.applyUnconfirmed', {
                  defaultValue: 'Outcome unconfirmed due to a network error. Encounter state refreshed.',
                })}
              </p>
              <Btn
                data-testid="action-use-retry"
                disabled={commit.isPending}
                onClick={() => {
                  commit.mutate({ chainId: preview.chainId, sourceEncounterId: encounterId });
                }}
              >
                {commit.isPending ? 'Retrying…' : 'Retry'}
              </Btn>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={commit.isPending || isUnconfirmed}
              onClick={() => {
                setStep('targets');
                setPreview(null);
                setCommitSubmitted(false);
                setIsUnconfirmed(false);
              }}
            >
              Back
            </button>
            {!isUnconfirmed && (preview.canApply || (isDm && !preview.applied)) && (
              <Btn
                data-testid="action-use-apply"
                disabled={applyDisabled || commit.isPending || commitSubmitted || preview.applied}
                onClick={() => {
                  if (commitSubmitted || commit.isPending) return;
                  commit.mutate({ chainId: preview.chainId, sourceEncounterId: encounterId });
                }}
              >
                {commit.isPending ? 'Applying…' : 'Apply'}
              </Btn>
            )}
            {!preview.canApply && !isDm && !isUnconfirmed && (
              <Btn data-testid="action-use-done" onClick={onDismiss}>
                Done
              </Btn>
            )}
          </div>
        </>
      )}
    </div>
  );
}

