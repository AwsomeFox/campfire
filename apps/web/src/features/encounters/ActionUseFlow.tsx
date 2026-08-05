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
import { GatedControl } from '../../components/GatedControl';
import { useAnnounce } from '../../components/Announcer';
import { QuickRollButtons } from './QuickRollButtons';

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

export function legalTargets(combatants: Combatant[], actorId: number, allow: ActionTargetAllow): Combatant[] {
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
  targetIds,
  onToggleTarget,
  isDm,
  applyDisabled = false,
  applyGateReason,
  onDismiss,
  onApplied,
  onError,
  onPreview,
  onPreviewStart,
  onPreviewError,
  onBackToTargets,
}: {
  encounterId: number;
  actorCombatantId: number;
  actorName: string;
  actionIndex: number;
  actionName: string;
  spec: ActionSpec;
  combatants: Combatant[];
  targetIds: number[];
  onToggleTarget: (id: number) => void;
  isDm: boolean;
  applyDisabled?: boolean;
  /**
   * Localized reason the Apply control is gated right now, or `undefined` when it is not
   * (issue #1933 review). Scoped to Apply alone: `ActionResolverService.apply` calls
   * `assertNotHeld`, but `resolve` (the preview) stays open during a safety hold on
   * purpose, so the roll/preview controls beside it must NOT inherit this.
   */
  applyGateReason?: string;
  onDismiss: () => void;
  onApplied: (undoToken: ActionUndoToken, policy: ActionApplyPolicy, sourceEncounterId: number) => void;
  onError: (msg: string | null) => void;
  onPreview: () => void;
  onPreviewStart: () => void;
  onPreviewError: () => void;
  onBackToTargets: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('targets');
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
        // Issue #1901 rework (review: chatgpt-codex-connector P1): bind the resolve request
        // to the action the panel actually opened for, not just its index. If an equipped
        // item's action is removed/unequipped/reordered while this panel is open, a later
        // action can shift into `actionIndex` — resolveSpec's own index/name cross-check
        // (see ActionResolverService) rejects that mismatch with a clean 400 instead of
        // silently resolving whatever now sits at that index.
        actionName,
        // Round 2 of the same fix (review: chatgpt-codex-connector P1): action names are not
        // unique on a sheet, so a name match alone can't tell two different actions apart if
        // one was swapped in for another under the same name while this panel was open.
        // `spec` is the exact content this panel already opened for (the fetched row) —
        // sending it as `expectedSpec` makes the server verify content, not just name, and
        // reject a mismatch instead of resolving whatever now sits at that index/name.
        expectedSpec: spec,
        targetIds,
        commit: false,
        rollMode,
      }),
    onMutate: () => { onPreviewStart(); onError(null); },
    onSuccess: (res) => {
      setPreview(res);
      setStep('preview');
      onPreview();
      announce(res.resolution.playerSummary);
    },
    onError: (err) => { onPreviewError(); onError(translateApiError(err, t, { fallbackKey: 'encounters.errors.resolveAction' })); },
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
        <QuickRollButtons
          encounterId={encounterId}
          combatantId={actorCombatantId}
          actorName={actorName}
          actionName={actionName}
          spec={spec}
          disabled={commit.isPending || commitSubmitted || isUnconfirmed || applyDisabled}
        />
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
                    onClick={() => onToggleTarget(c.id)}
                    style={{ minHeight: 44, minWidth: 44, cursor: 'pointer', border: 0 }}
                  >
                    {c.name}
                  </button>
                ))}
                {candidates.length === 0 && <span className="text-muted" style={{ fontSize: 12 }}>{t('encounters.actionFlow.noTargets')}</span>}
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
          {preview.systemMathSupported === false && (
            <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }} data-testid="action-use-system-math-notice">
              {/* Must not name 5e/d20: `systemMathSupported === false` also covers adapters
                  that supply their own resolveAttack (OSR descending-AC, Open Legend
                  exploding pools), where the system's OWN math ran. Keep this in step with
                  the catalog string — action-use-system-math-notice.unit.spec.ts asserts
                  both this default and the catalog value are free of that claim. */}
              {t('encounters.actionFlow.systemMathNotice', {
                defaultValue: "Resolved with math that hasn't been audited for your system — verify the result.",
              })}
            </p>
          )}
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
                onBackToTargets();
              }}
            >
              Back
            </button>
            {!isUnconfirmed && (preview.canApply || (isDm && !preview.applied)) && (
              <GatedControl
                // Suppressed while the commit is in flight or already applied: `busy` is
                // the operative blocker then, not the hold, and GatedControl strips the
                // native `disabled` whenever a reason is present (issue #1933 review).
                reason={commit.isPending || commitSubmitted || preview.applied ? undefined : applyGateReason}
              >
                <Btn
                  data-testid="action-use-apply"
                  // `applyGateReason != null` is the Apply-ONLY blocker (currently the
                  // safety hold). It must not live in `applyDisabled`, which also feeds
                  // QuickRollButtons above — `/quick-roll` is not hold-guarded server-side.
                  disabled={
                    applyDisabled || applyGateReason != null || commit.isPending || commitSubmitted || preview.applied
                  }
                  onClick={() => {
                    if (commitSubmitted || commit.isPending) return;
                    commit.mutate({ chainId: preview.chainId, sourceEncounterId: encounterId });
                  }}
                >
                  {commit.isPending ? 'Applying…' : 'Apply'}
                </Btn>
              </GatedControl>
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
