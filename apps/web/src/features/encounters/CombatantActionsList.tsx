/**
 * Playable action list for monster/NPC combatants (issue #425).
 * Fetches resolver-ready actions from the server (inline statblock or expanded compendium).
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { parseRechargeRange, type ActionSpec, type UsableAction, type UsableActionUses } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { Btn } from '../../components/ui';
import { QuickRollButtons } from './QuickRollButtons';

/** Translate function shape, spelled without angle-bracket generics (issue #1940 JSX-text ratchet scans raw ">...<" spans, including TS type syntax, in this directory). */
export type Translate = (key: string, opts?: { defaultValue?: string; min?: number; max?: number; count?: number; label?: string }) => string;

/**
 * Issue #1921: "Recharge 5–6 · spent" / "1/day · 0 left" — server-computed `uses` state
 * turned into a display label. Never re-derives spend math client-side (see
 * {@link UsableAction.uses}'s own doc comment); this only formats what the server sent.
 * Exported for a pure unit test (apps/web/e2e/tests/*.unit.spec.ts) — no component render
 * needed to check the formatting.
 */
export function usesBadge(uses: UsableActionUses, t: Translate): string {
  // Only a DIE-ROLL condition takes the recharge branch. `recharge` also carries rest
  // cadences ('long-rest', 'dawn', …); branching on "non-empty" printed the raw slug and
  // swallowed the count, so a `{ max: 3, recharge: 'long-rest' }` pool rendered as
  // "long-rest" with no idea how many uses were left — even though it IS tracked on `max`.
  const range = uses.recharge ? parseRechargeRange(uses.recharge) : null;
  if (range) {
    const pool =
      range.min === range.max
        ? t('encounters.actions.uses.rechargeSingle', { min: range.min, defaultValue: `Recharge ${range.min}` })
        : t('encounters.actions.uses.recharge', { min: range.min, max: range.max, defaultValue: `Recharge ${range.min}–${range.max}` });
    if (uses.available > 0) return pool;
    return `${pool} · ${t('encounters.actions.uses.spent', { defaultValue: 'spent' })}`;
  }
  const pool = t('encounters.actions.uses.perDay', { max: uses.max, defaultValue: `${uses.max}/day` });
  const left = t('encounters.actions.uses.left', { count: uses.available, defaultValue: `${uses.available} left` });
  return `${pool} · ${left}`;
}

export function CombatantActionsList({
  encounterId,
  combatantId,
  combatantName: _combatantName = 'Unknown',
  campaignId: _campaignId,
  enabled,
  /**
   * Issue #1746: when set, the list stays mounted (permission is unchanged) but every
   * "Use" button renders disabled and describes why via `aria-describedby` — e.g. the
   * encounter sync gate blocking conflict-prone writes. Distinct from `enabled`, which
   * governs whether the list mounts/fetches at all.
   */
  disabledReason,
  onUseAction,
  onUseGroupAction,
}: {
  encounterId: number;
  combatantId: number;
  combatantName?: string;
  campaignId?: number;
  enabled: boolean;
  disabledReason?: string;
  onUseAction: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
  /**
   * Issue #1922: open the group action runner instead of the single-actor Use flow — same
   * DM-only gating as `onUseAction` (undefined for a player/viewer or a linked-character row),
   * plus the full `UsableAction` row so the caller can derive the (name, toHit, damage)
   * fingerprint other combatants are matched against.
   */
  onUseGroupAction?: (actionIndex: number, actionName: string, spec: ActionSpec, action: UsableAction) => void;
}) {
  const { t } = useTranslation();

  const { data: actions = [] } = useQuery({
    queryKey: [...queryKeys.encounter(encounterId), 'actions', combatantId],
    queryFn: () => api.get<UsableAction[]>(`${API}/encounters/${encounterId}/combatants/${combatantId}/actions`),
    enabled,
    staleTime: 5_000,
  });
  const playable = actions.filter((a) => a.resolvable && a.spec);
  if (!enabled || playable.length === 0) return null;
  const blockedReasonId = `combatant-actions-${combatantId}-blocked-reason`;
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="combatant-actions-list">
      <span className="text-xs font-semibold text-muted">{t('encounters.actions.title', { defaultValue: 'Actions' })}</span>
      {disabledReason && (
        <span id={blockedReasonId} className="sr-only">
          {disabledReason}
        </span>
      )}
      {playable.map((a) => {
        // Issue #1921: exhausted (available === 0) disables Use for THIS action specifically,
        // independent of (and composable with) the list-wide sync-block `disabledReason`.
        const exhausted = !!a.uses && a.uses.available <= 0;
        const exhaustedReasonId = `combatant-actions-${combatantId}-${a.index}-exhausted-reason`;
        const useReason =
          disabledReason ??
          (exhausted
            ? t('encounters.actions.uses.disabledReason', {
                label: a.uses ? usesBadge(a.uses, t) : '',
                defaultValue: `No uses remaining (${a.uses ? usesBadge(a.uses, t) : ''})`,
              })
            : undefined);
        return (
          <div key={a.index} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
              <span className="font-medium text-white">{a.name}</span>
              {a.uses && (
                <span
                  id={exhausted ? exhaustedReasonId : undefined}
                  className={`text-xs rounded px-1.5 py-0.5 ${exhausted ? 'bg-amber-900/40 text-amber-300' : 'bg-white/10 text-muted'}`}
                >
                  {usesBadge(a.uses, t)}
                </span>
              )}
              <QuickRollButtons
                encounterId={encounterId}
                combatantId={combatantId}
                actionName={a.name}
                toHit={a.toHit}
                damage={a.damage}
                spec={a.spec}
                disabled={!!disabledReason}
              />
              {a.notes && <span className="text-xs text-muted">({a.notes})</span>}
            </div>
          <div className="flex items-center gap-1 shrink-0">
            {onUseGroupAction && (
              <Btn
                type="button"
                ghost
                className="!min-h-8 text-xs"
                data-testid={`combatant-actions-${combatantId}-use-group-${a.index}`}
                disabled={!!disabledReason}
                title={disabledReason}
                aria-describedby={disabledReason ? blockedReasonId : undefined}
                onClick={() => a.spec && onUseGroupAction(a.index, a.name, a.spec, a)}
              >
                {t('encounters.actions.useGroup', { defaultValue: 'Run for group' })}
              </Btn>
            )}
            <Btn
              type="button"
              ghost
              className="!min-h-8 text-xs"
              disabled={!!useReason}
              title={useReason}
              aria-describedby={disabledReason ? blockedReasonId : exhausted ? exhaustedReasonId : undefined}
              onClick={() => a.spec && onUseAction(a.index, a.name, a.spec)}
            >
              {t('encounters.actions.use', { defaultValue: 'Use' })}
            </Btn>
          </div>
        </div>
      );
    })}
    </div>
  );
}
