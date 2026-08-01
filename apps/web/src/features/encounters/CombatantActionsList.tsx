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
import { useRoller } from '../../lib/useRoller';
import { advFromEvent, damageExpr, toHitExpr } from '../../lib/characterStats';

export function CombatantActionsList({
  encounterId,
  combatantId,
  combatantName = 'Unknown',
  campaignId,
  enabled,
  /**
   * Issue #1746: when set, the list stays mounted (permission is unchanged) but every
   * "Use" button renders disabled and describes why via `aria-describedby` — e.g. the
   * encounter sync gate blocking conflict-prone writes. Distinct from `enabled`, which
   * governs whether the list mounts/fetches at all.
   */
  disabledReason,
  onUseAction,
}: {
  encounterId: number;
  combatantId: number;
  combatantName?: string;
  campaignId?: number;
  enabled: boolean;
  disabledReason?: string;
  onUseAction: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
}) {
  const { t } = useTranslation();
  
  const { roll } = useRoller(campaignId ?? 0, () => {});

  const handleRollAttack = (e: React.MouseEvent, actionName: string, toHit: string) => {
    e.stopPropagation();
    if (!campaignId) return;
    const expr = toHitExpr(toHit, advFromEvent(e));
    if (!expr) return;
    const modeText = e.shiftKey ? ' (Advantage)' : (e.altKey || e.metaKey) ? ' (Disadvantage)' : '';
    void roll(expr, `${combatantName} · ${actionName}${modeText}`);
  };

  const handleRollDamage = (e: React.MouseEvent, actionName: string, damageStr: string) => {
    e.stopPropagation();
    if (!campaignId) return;
    const expr = damageExpr(damageStr);
    if (!expr) return;
    void roll(expr, `${combatantName} · ${actionName} damage`);
  };

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
        const canRollHit = !!a.toHit && toHitExpr(a.toHit, 'flat') != null;
        const canRollDmg = !!a.damage && damageExpr(a.damage) != null;
        
        return (
          <div key={a.index} className="flex items-start justify-between gap-2 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                <span className="font-medium text-white mr-1">{a.name}</span>
                {a.toHit && (
                  <Btn
                    type="button"
                    ghost
                    density="xs"
                    className="text-xs font-semibold"
                    disabled={!campaignId || !!disabledReason || !canRollHit}
                    onClick={(e) => handleRollAttack(e, a.name, a.toHit)}
                    title="Shift-click for advantage, Alt/Option-click for disadvantage"
                  >
                    🎯 {a.toHit.startsWith('+') || a.toHit.startsWith('-') ? a.toHit : '+' + a.toHit}
                  </Btn>
                )}
                {a.damage && (
                  <Btn
                    type="button"
                    ghost
                    density="xs"
                    className="text-xs font-semibold"
                    disabled={!campaignId || !!disabledReason || !canRollDmg}
                    onClick={(e) => handleRollDamage(e, a.name, a.damage)}
                  >
                    💥 {a.damage}
                  </Btn>
                )}
              </div>
              {a.notes && <p className="text-xs text-muted m-0 mt-0.5">{a.notes}</p>}
            </div>
            <Btn
              type="button"
              ghost
              className="!min-h-8 shrink-0 text-xs"
              disabled={!!disabledReason}
              title={disabledReason}
              aria-describedby={disabledReason ? blockedReasonId : undefined}
              onClick={() => a.spec && onUseAction(a.index, a.name, a.spec)}
            >
              {t('encounters.actions.use', { defaultValue: 'Use' })}
            </Btn>
          </div>
        );
      })}
    </div>
  );
}
