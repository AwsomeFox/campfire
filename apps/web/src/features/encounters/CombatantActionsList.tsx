/**
 * Playable action list for monster/NPC combatants (issue #425).
 * Fetches resolver-ready actions from the server (inline statblock or expanded compendium).
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ActionSpec, UsableAction } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { Btn } from '../../components/ui';
import { QuickRollButtons } from './QuickRollButtons';

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
      {playable.map((a) => (
        <div key={a.index} className="flex items-center justify-between gap-2 text-sm">
          <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
            <span className="font-medium text-white">{a.name}</span>
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
              disabled={!!disabledReason}
              title={disabledReason}
              aria-describedby={disabledReason ? blockedReasonId : undefined}
              onClick={() => a.spec && onUseAction(a.index, a.name, a.spec)}
            >
              {t('encounters.actions.use', { defaultValue: 'Use' })}
            </Btn>
          </div>
        </div>
      ))}
    </div>
  );
}
