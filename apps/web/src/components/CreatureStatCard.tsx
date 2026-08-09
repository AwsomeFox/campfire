import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatCheckBreakdown, sortCheckCatalog, type CheckRollResponse, type RollCheckDefinition } from '@campfire/schema';
import { api, API, ApiError } from '../lib/api';
import { queryKeys, invalidateEncounter } from '../lib/query';
import { useDisclosure } from './useDisclosure';
import { RollContextMenu, type RollMode } from './RollContextMenu';
import { useRollResultToast } from './RollResultToastContext';

/** DM-only encounter creature mechanics, backed exclusively by the server catalog (#1314). */
export function CreatureStatCard({
  encounterId,
  combatantId,
  creatureName,
  onError,
}: {
  encounterId: number;
  combatantId: number;
  creatureName: string;
  onError: (message: string | null) => void;
}) {
  const { open, buttonProps, regionProps } = useDisclosure({ initialOpen: false, focusManagement: false, regionLabel: `${creatureName} creature mechanics` });
  const queryClient = useQueryClient();
  const { showRoll } = useRollResultToast();
  const { data: checks = [], error: loadError } = useQuery({
    queryKey: [...queryKeys.encounter(encounterId), 'creature-checks', combatantId],
    queryFn: () => api.get<RollCheckDefinition[]>(`${API}/encounters/${encounterId}/combatants/${combatantId}/checks`),
    enabled: open,
    staleTime: 5_000,
  });
  const ordered = useMemo(() => sortCheckCatalog(checks), [checks]);
  const roll = useMutation({
    mutationFn: ({ checkId, mode }: { checkId: string; mode: RollMode }) =>
      api.post<CheckRollResponse>(`${API}/encounters/${encounterId}/combatants/${combatantId}/checks/roll`, { checkId, mode }),
    onSuccess: ({ roll: result }) => {
      invalidateEncounter(queryClient, encounterId);
      showRoll(result);
    },
    onError: (error) => onError(error instanceof ApiError ? error.message : "Couldn't roll the creature check."),
  });
  const rollCheck = (check: RollCheckDefinition, mode: RollMode) => {
    onError(null);
    roll.mutate({ checkId: check.id, mode: check.supportsAdvantage ? mode : 'normal' });
  };
  const byCategory = (category: RollCheckDefinition['category']) => ordered.filter((check) => check.category === category);
  const render = (check: RollCheckDefinition) => (
    <RollContextMenu
      key={check.id}
      className={check.favorite ? 'tag tag-accent' : 'tag tag-neutral'}
      style={{ minHeight: 36, border: 0, cursor: 'pointer' }}
      allowAdvantage={check.supportsAdvantage}
      allowCrit={false}
      disabled={roll.isPending}
      title={`Roll ${check.label} — ${formatCheckBreakdown(check)}`}
      aria-label={`Roll ${check.label}: ${formatCheckBreakdown(check)}`}
      data-testid={`creature-check-roll-${check.id}`}
      onRoll={(mode) => rollCheck(check, mode)}
    >
      {check.label} {check.modifier >= 0 ? `+${check.modifier}` : check.modifier}
    </RollContextMenu>
  );
  return (
    <div style={{ marginTop: 5 }} data-testid="creature-stat-card">
      <button type="button" className="btn btn-ghost" {...buttonProps} aria-label={`${open ? 'Collapse' : 'Expand'} ${creatureName}'s creature mechanics`} style={{ fontSize: 10.5, minHeight: 24, padding: '2px 8px', border: '1px dashed var(--color-divider)', borderRadius: 'var(--radius-md)' }}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Creature mechanics
      </button>
      {open && (
        <div {...regionProps} style={{ marginTop: 6, padding: '10px 12px', border: '1px solid var(--color-divider)', borderRadius: 'var(--radius-md)', maxWidth: 460, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loadError ? <span role="alert" className="text-muted" style={{ fontSize: 12 }}>{loadError instanceof ApiError ? loadError.message : "Couldn't load creature mechanics."}</span> : ordered.length === 0 ? <span className="text-muted" style={{ fontSize: 12 }}>No rollable mechanics are supplied by this statblock.</span> : (
            (['ability', 'save', 'skill'] as const).map((category) => {
              const entries = byCategory(category);
              if (!entries.length) return null;
              return <section key={category}><span className="card-kicker">{category === 'ability' ? 'Ability checks' : category === 'save' ? 'Saving throws' : 'Skills'}</span><div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{entries.map(render)}</div></section>;
            })
          )}
        </div>
      )}
    </div>
  );
}
