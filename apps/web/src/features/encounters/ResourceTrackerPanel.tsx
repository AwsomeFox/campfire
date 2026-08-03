import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ruleSystemAdapter, restOptionsForAdapter } from '@campfire/schema';
import type { Character, Combatant, CharacterResource, RestOptionDef, SpellSlotLevel } from '@campfire/schema';
import { Card, Btn, ErrorNote } from '../../components/ui';
import { api, API, translateApiError } from '../../lib/api';
import { invalidateEncounter, invalidateCampaignCharacters, queryKeys } from '../../lib/query';
import { useCampaign } from '../../app/CampaignContext';
import {
  restRequestBody,
  resourcePatchBody,
  spellSlotPatchBody,
  canEditCharacterResource,
  hasTrackedResources,
} from './resourceTrackerLogic';

function Pips({
  max,
  used,
  disabled,
  onChange,
}: {
  max: number;
  used: number;
  disabled?: boolean;
  onChange: (used: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1 flex-wrap">
      {Array.from({ length: max }).map((_, i) => {
        const target = i < used ? i : i + 1;
        return (
          <button
            key={i}
            className="w-4 h-4 rounded-full border border-current flex items-center justify-center cursor-pointer opacity-80 hover:opacity-100 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={disabled}
            onClick={() => onChange(target)}
            title={t('encounters.resourceTracker.setUsedTitle', { val: target, defaultValue: `Set used to ${target}` })}
            type="button"
          >
            {i < used ? '●' : '○'}
          </button>
        );
      })}
    </div>
  );
}

export function ResourceTrackerPanel({
  campaignId,
  encounterId,
  characters,
  combatants,
  canDmWrite,
  canPlayerWrite,
  ownedCharacterIds,
}: {
  campaignId?: number;
  encounterId: number;
  characters: Character[];
  combatants: Combatant[];
  canDmWrite: boolean;
  canPlayerWrite: boolean;
  ownedCharacterIds: ReadonlySet<number>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  // Issue #1902 rework: the campaign's rule-system adapter drives which rests are on
  // offer, exactly like CharacterPage's RestControls — a Starfinder table gets its
  // stamina/night cadence instead of a generic short/long rest that restores no SP and
  // spends no RP.
  const campaign = useCampaign(campaignId);
  const adapter = ruleSystemAdapter(campaign?.ruleSystem);
  const restOptions = restOptionsForAdapter(adapter);

  const invalidate = () => {
    invalidateEncounter(queryClient, encounterId);
    if (campaignId != null) invalidateCampaignCharacters(queryClient, campaignId);
  };

  const restMutation = useMutation({
    mutationFn: async ({ characterId, kind }: { characterId: number; kind: RestOptionDef['type'] }) =>
      api.post(`${API}/characters/${characterId}/rest`, restRequestBody(kind)),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.restError' }));
      invalidate();
    },
  });

  const resourceMutation = useMutation({
    mutationFn: async ({ characterId, key, used }: { characterId: number; key: string; used: number }) =>
      api.post(`${API}/characters/${characterId}/resources`, resourcePatchBody(key, used)),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.updateResourceError' }));
      invalidate();
    },
  });

  const slotMutation = useMutation({
    mutationFn: async ({
      characterId,
      level,
      currentUsed,
      used,
    }: {
      characterId: number;
      level: number;
      currentUsed: number;
      used: number;
    }) =>
      api.post<Character>(`${API}/characters/${characterId}/spell-slots`, spellSlotPatchBody(level, currentUsed, used)),
    // Issue #1902 rework: `spellSlotPatchBody` sends a DELTA relative to the `used` value
    // rendered on screen. If we waited for `invalidate()`'s background refetch to land
    // before trusting `slot.used` again, a second click in that window would compute its
    // delta against the stale pre-write value and over/under-shoot the server's true
    // count. The POST response IS the fresh character (server-authoritative `spellSlots`),
    // so write it into the cache synchronously, before the query has any chance to be read
    // again — this closes the race without a debounce or a second round-trip.
    onSuccess: (updated) => {
      setError(null);
      if (campaignId != null) {
        queryClient.setQueryData<Character[]>(queryKeys.campaignCharacters(campaignId), (old) =>
          old?.map((c) => (c.id === updated.id ? updated : c)),
        );
      }
      invalidate();
    },
    onError: (err) => {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.updateSlotError' }));
      invalidate();
    },
  });

  const statblockMutation = useMutation({
    mutationFn: async ({
      combatantId,
      statblock,
    }: {
      combatantId: number;
      statblock: Record<string, unknown>;
      // Issue #1902 rework: this one mutation backs both statblock resource pips and
      // statblock spell-slot pips. `kind` lets `onError` pick the fallback message that
      // matches which control actually failed, instead of always reporting "resource".
      kind: 'resource' | 'slot';
    }) => api.patch(`${API}/encounters/${encounterId}/combatants/${combatantId}`, { statblock }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err, variables) => {
      const fallbackKey =
        variables.kind === 'slot' ? 'encounters.resourceTracker.updateSlotError' : 'encounters.resourceTracker.updateResourceError';
      setError(translateApiError(err, t, { fallbackKey }));
      invalidate();
    },
  });

  const isPending =
    restMutation.isPending || resourceMutation.isPending || slotMutation.isPending || statblockMutation.isPending;

  const rows = combatants
    .map((c) => {
      let resources: Record<string, CharacterResource> = {};
      let spellSlots: Record<string, SpellSlotLevel> = {};
      let name = c.name;

      if (c.kind === 'character' && c.characterId) {
        const char = characters.find((ch) => ch.id === c.characterId);
        if (char) {
          resources = char.resources;
          spellSlots = char.spellSlots;
          name = char.name;
        }
      } else if (c.statblock) {
        const sb = c.statblock as unknown as Record<string, unknown>;
        resources = (sb.resources as Record<string, CharacterResource>) || {};
        spellSlots = (sb.spellSlots as Record<string, SpellSlotLevel>) || {};
      }

      const canEdit = canEditCharacterResource({
        canDmWrite,
        canPlayerWrite,
        characterId: c.kind === 'character' ? (c.characterId ?? null) : null,
        ownedCharacterIds,
      });

      return { combatant: c, name, resources, spellSlots, canEdit };
    })
    .filter((row) => hasTrackedResources(row.resources, row.spellSlots));

  if (rows.length === 0) return null;

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">{t('encounters.resourceTracker.title', { defaultValue: 'Resource Tracker' })}</h3>
        {canDmWrite && campaignId != null && (
          <Link to={`/c/${campaignId}/party`} className="text-xs font-medium underline opacity-80 hover:opacity-100" data-testid="resource-tracker-party-rest-link">
            {t('encounters.resourceTracker.partyRest', { defaultValue: 'Party Rest' })} →
          </Link>
        )}
      </div>

      {error && (
        <ErrorNote message={error} onDismiss={() => setError(null)} />
      )}

      <div className="space-y-4 max-h-96 overflow-y-auto">
        {rows.map(({ combatant: c, name, resources, spellSlots, canEdit }) => (
          <div key={c.id} className="border-t pt-2 mt-2 first:mt-0 first:border-0 first:pt-0">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="font-medium">{name}</div>
              {canEdit && c.kind === 'character' && c.characterId != null && restOptions.length > 0 && (
                <div className="flex gap-2">
                  {restOptions.map((opt) => (
                    <Btn
                      key={opt.type}
                      density="compact"
                      disabled={isPending}
                      title={opt.description}
                      onClick={() => {
                        if (!window.confirm(t('encounters.resourceTracker.confirmRest', { name, kind: opt.label, defaultValue: `${opt.label} for ${name}?` }))) return;
                        restMutation.mutate({ characterId: c.characterId as number, kind: opt.type });
                      }}
                    >
                      {opt.label}
                    </Btn>
                  ))}
                </div>
              )}
            </div>

            {Object.keys(resources).length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase text-muted">{t('encounters.resourceTracker.features', { defaultValue: 'Features' })}</div>
                {Object.entries(resources).map(([key, res]) => {
                  const sourceVal = (res as Record<string, unknown>).source;
                  const sourceText = typeof sourceVal === 'string' || typeof sourceVal === 'number' ? String(sourceVal) : null;
                  return (
                    <div key={key} className="flex items-center justify-between gap-4">
                      <div className="text-sm">
                        {res.name || key}
                        {res.recharge && <span className="ml-2 text-xs opacity-70">({res.recharge})</span>}
                        {sourceText && <span className="ml-2 text-xs opacity-70">[{sourceText}]</span>}
                      </div>
                      <Pips
                        max={res.max}
                        used={res.used}
                        disabled={!canEdit || isPending}
                        onChange={(val) => {
                          if (!canEdit) return;
                          if (c.kind === 'character' && c.characterId) {
                            resourceMutation.mutate({ characterId: c.characterId, key, used: val });
                          } else if (c.statblock) {
                            const sb = c.statblock as unknown as Record<string, unknown>;
                            statblockMutation.mutate({
                              combatantId: c.id,
                              statblock: { ...c.statblock, resources: { ...(sb.resources as Record<string, unknown>), [key]: { ...res, used: val } } },
                              kind: 'resource',
                            });
                          }
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {Object.keys(spellSlots).length > 0 && (
              <div className="space-y-2 mt-3">
                <div className="text-xs font-semibold uppercase text-muted">{t('encounters.resourceTracker.spellSlots', { defaultValue: 'Spell Slots' })}</div>
                {Object.entries(spellSlots).map(([level, slot]) => (
                  <div key={level} className="flex items-center justify-between gap-4">
                    <div className="text-sm">{t('encounters.resourceTracker.level', { level, defaultValue: `Level ${level}` })}</div>
                    <Pips
                      max={slot.max}
                      used={slot.used}
                      disabled={!canEdit || isPending}
                      onChange={(val) => {
                        if (!canEdit) return;
                        if (c.kind === 'character' && c.characterId) {
                          slotMutation.mutate({ characterId: c.characterId, level: Number(level), currentUsed: slot.used, used: val });
                        } else if (c.statblock) {
                          const sb = c.statblock as unknown as Record<string, unknown>;
                          statblockMutation.mutate({
                            combatantId: c.id,
                            statblock: { ...c.statblock, spellSlots: { ...(sb.spellSlots as Record<string, unknown>), [level]: { ...slot, used: val } } },
                            kind: 'slot',
                          });
                        }
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
