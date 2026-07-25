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

export function CombatantActionsList({
  encounterId,
  combatantId,
  enabled,
  onUseAction,
}: {
  encounterId: number;
  combatantId: number;
  enabled: boolean;
  onUseAction: (actionIndex: number, actionName: string, spec: ActionSpec) => void;
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
  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="combatant-actions-list">
      <span className="text-xs font-semibold text-muted">{t('encounters.actions.title', { defaultValue: 'Actions' })}</span>
      {playable.map((a) => (
        <div key={a.index} className="flex items-start justify-between gap-2 text-sm">
          <div className="min-w-0">
            <span className="font-medium text-white">{a.name}</span>
            {(a.toHit || a.damage) && (
              <span className="text-muted text-xs">
                {' '}
                · {[a.toHit, a.damage].filter(Boolean).join(' ')}
              </span>
            )}
            {a.notes && <p className="text-xs text-muted m-0 mt-0.5">{a.notes}</p>}
          </div>
          <Btn
            type="button"
            ghost
            className="!min-h-8 shrink-0 text-xs"
            onClick={() => a.spec && onUseAction(a.index, a.name, a.spec)}
          >
            {t('encounters.actions.use', { defaultValue: 'Use' })}
          </Btn>
        </div>
      ))}
    </div>
  );
}
