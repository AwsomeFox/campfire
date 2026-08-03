import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import type { Character, Combatant, CharacterResource, SpellSlotLevel } from '@campfire/schema';
import { Card, Btn } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { api, API, translateApiError } from '../../lib/api';

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
        const targetUsed = i < used ? i : i + 1;
        return (
          <button
            key={i}
            className="w-4 h-4 rounded-full border border-current flex items-center justify-center cursor-pointer opacity-80 hover:opacity-100 disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={disabled}
            onClick={() => onChange(targetUsed)}
            title={t('encounters.resourceTracker.setUsedTitle', { val: targetUsed, defaultValue: `Set used to ${targetUsed}` })}
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
  ownedCharacterIds,
}: {
  campaignId?: number;
  encounterId: number;
  characters: Character[];
  combatants: Combatant[];
  canDmWrite: boolean;
  ownedCharacterIds?: Set<number>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [confirmRest, setConfirmRest] = useState<{
    characterId: number;
    characterName: string;
    kind: 'short' | 'long';
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const invalidateQueries = (charId?: number) => {
    void queryClient.invalidateQueries({ queryKey: ['encounters', encounterId] });
    void queryClient.invalidateQueries({ queryKey: ['characters'] });
    if (charId) {
      void queryClient.invalidateQueries({ queryKey: ['characters', charId] });
    }
  };

  const restMutation = useMutation({
    mutationFn: async ({ characterId, kind }: { characterId: number; kind: 'short' | 'long' }) => {
      await api.post(`${API}/characters/${characterId}/rest`, { type: kind });
    },
    onSuccess: (_, { characterId }) => {
      setErrorMsg(null);
      invalidateQueries(characterId);
    },
    onError: (err, { characterId }) => {
      const msg = translateApiError(err, t, {
        fallbackKey: 'encounters.resourceTracker.restError',
      });
      setErrorMsg(msg);
      invalidateQueries(characterId);
    },
  });

  const resourceMutation = useMutation({
    mutationFn: async ({
      characterId,
      key,
      used,
    }: {
      characterId: number;
      key: string;
      used: number;
    }) => {
      await api.post(`${API}/characters/${characterId}/resources`, { key, used });
    },
    onSuccess: (_, { characterId }) => {
      setErrorMsg(null);
      invalidateQueries(characterId);
    },
    onError: (err, { characterId }) => {
      const msg = translateApiError(err, t, {
        fallbackKey: 'encounters.resourceTracker.updateResourceError',
      });
      setErrorMsg(msg);
      invalidateQueries(characterId);
    },
  });

  const slotMutation = useMutation({
    mutationFn: async ({
      characterId,
      level,
      delta,
    }: {
      characterId: number;
      level: number;
      delta: number;
    }) => {
      await api.post(`${API}/characters/${characterId}/spell-slots`, { level, delta });
    },
    onSuccess: (_, { characterId }) => {
      setErrorMsg(null);
      invalidateQueries(characterId);
    },
    onError: (err, { characterId }) => {
      const msg = translateApiError(err, t, {
        fallbackKey: 'encounters.resourceTracker.updateSlotError',
      });
      setErrorMsg(msg);
      invalidateQueries(characterId);
    },
  });

  const statblockMutation = useMutation({
    mutationFn: async ({
      combatantId,
      patchStatblock,
    }: {
      combatantId: number;
      patchStatblock: Record<string, unknown>;
    }) => {
      await api.patch(`${API}/encounters/${encounterId}/combatants/${combatantId}`, {
        statblock: patchStatblock,
      });
    },
    onSuccess: () => {
      setErrorMsg(null);
      invalidateQueries();
    },
    onError: (err) => {
      const msg = translateApiError(err, t, {
        fallbackKey: 'encounters.resourceTracker.updateResourceError',
      });
      setErrorMsg(msg);
      invalidateQueries();
    },
  });

  const combatantsWithStuff = combatants
    .map((c) => {
      let resources: Record<string, CharacterResource> = {};
      let spellSlots: Record<string, SpellSlotLevel> = {};
      let characterName = c.name;

      if (c.kind === 'character' && c.characterId) {
        const char = characters.find((ch) => ch.id === c.characterId);
        if (char) {
          resources = char.resources || {};
          spellSlots = char.spellSlots || {};
          characterName = char.name;
        }
      } else if (c.statblock) {
        const sb = c.statblock as unknown as Record<string, unknown>;
        resources = (sb.resources as Record<string, CharacterResource>) || {};
        spellSlots = (sb.spellSlots as Record<string, SpellSlotLevel>) || {};
      }

      const hasResources = Object.keys(resources).length > 0;
      const hasSpellSlots = Object.keys(spellSlots).length > 0;
      const canEdit =
        canDmWrite ||
        (c.kind === 'character' && c.characterId != null && ownedCharacterIds?.has(c.characterId) === true);

      return {
        combatant: c,
        characterName,
        resources,
        spellSlots,
        hasResources,
        hasSpellSlots,
        canEdit,
      };
    })
    .filter((item) => item.hasResources || item.hasSpellSlots);

  if (combatantsWithStuff.length === 0) {
    return null;
  }

  const isPending =
    restMutation.isPending ||
    resourceMutation.isPending ||
    slotMutation.isPending ||
    statblockMutation.isPending;

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-lg">
          {t('encounters.resourceTracker.title', 'Resource Tracker')}
        </h3>
        {canDmWrite && campaignId != null && (
          <a
            href={`/campaigns/${campaignId}?tab=rest`}
            className="text-xs text-accent hover:underline font-medium"
            data-testid="party-rest-link"
          >
            {t('encounters.resourceTracker.partyRest', 'Party Rest')} →
          </a>
        )}
      </div>

      {errorMsg && (
        <div
          className="text-xs text-red-500 bg-red-500/10 p-2 rounded flex justify-between items-center"
          data-testid="resource-tracker-error"
        >
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)} className="ml-2 font-bold">
            ×
          </button>
        </div>
      )}

      <div className="space-y-4 max-h-96 overflow-y-auto">
        {combatantsWithStuff.map(
          ({ combatant: c, characterName, resources, spellSlots, hasResources, hasSpellSlots, canEdit }) => (
            <div key={c.id} className="border-t pt-2 mt-2 first:mt-0 first:border-0 first:pt-0">
              <div className="flex items-center justify-between mb-2">
                <div className="font-medium">{characterName}</div>
                {canEdit && c.kind === 'character' && c.characterId != null && (
                  <div className="flex gap-1">
                    <Btn
                      density="compact"
                      disabled={isPending}
                      onClick={() =>
                        setConfirmRest({
                          characterId: c.characterId!,
                          characterName,
                          kind: 'short',
                        })
                      }
                      title={t('encounters.resourceTracker.shortRest', 'Short Rest')}
                    >
                      {t('encounters.resourceTracker.shortRest', 'Short Rest')}
                    </Btn>
                    <Btn
                      density="compact"
                      disabled={isPending}
                      onClick={() =>
                        setConfirmRest({
                          characterId: c.characterId!,
                          characterName,
                          kind: 'long',
                        })
                      }
                      title={t('encounters.resourceTracker.longRest', 'Long Rest')}
                    >
                      {t('encounters.resourceTracker.longRest', 'Long Rest')}
                    </Btn>
                  </div>
                )}
              </div>

              {hasResources && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase text-muted">
                    {t('encounters.resourceTracker.features', 'Features')}
                  </div>
                  {Object.entries(resources).map(([key, res]) => {
                    const sourceVal = (res as Record<string, unknown>).source;
                    const sourceText =
                      typeof sourceVal === 'string' || typeof sourceVal === 'number'
                        ? String(sourceVal)
                        : null;
                    return (
                      <div key={key} className="flex items-center justify-between gap-4">
                        <div className="text-sm">
                          {res.name || key}
                          {res.recharge && (
                            <span className="ml-2 text-xs opacity-70">({res.recharge})</span>
                          )}
                          {sourceText && (
                            <span className="ml-2 text-xs opacity-70">[{sourceText}]</span>
                          )}
                        </div>
                        <Pips
                          max={res.max}
                          used={res.used}
                          disabled={!canEdit || isPending}
                          onChange={(val) => {
                            if (!canEdit) return;
                            if (c.kind === 'character' && c.characterId) {
                              resourceMutation.mutate({
                                characterId: c.characterId,
                                key,
                                used: val,
                              });
                            } else if (c.statblock) {
                              const sb = c.statblock as unknown as Record<string, unknown>;
                              statblockMutation.mutate({
                                combatantId: c.id,
                                patchStatblock: {
                                  ...c.statblock,
                                  resources: {
                                    ...(sb.resources as Record<string, unknown>),
                                    [key]: { ...res, used: val },
                                  },
                                },
                              });
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}

              {hasSpellSlots && (
                <div className="space-y-2 mt-3">
                  <div className="text-xs font-semibold uppercase text-muted">
                    {t('encounters.resourceTracker.spellSlots', 'Spell Slots')}
                  </div>
                  {Object.entries(spellSlots).map(([level, slot]) => (
                    <div key={level} className="flex items-center justify-between gap-4">
                      <div className="text-sm">
                        {t('encounters.resourceTracker.level', { level, defaultValue: `Level ${level}` })}
                      </div>
                      <Pips
                        max={slot.max}
                        used={slot.used}
                        disabled={!canEdit || isPending}
                        onChange={(val) => {
                          if (!canEdit) return;
                          if (c.kind === 'character' && c.characterId) {
                            const delta = val - slot.used;
                            slotMutation.mutate({
                              characterId: c.characterId,
                              level: Number(level),
                              delta,
                            });
                          } else if (c.statblock) {
                            const sb = c.statblock as unknown as Record<string, unknown>;
                            statblockMutation.mutate({
                              combatantId: c.id,
                              patchStatblock: {
                                ...c.statblock,
                                spellSlots: {
                                  ...(sb.spellSlots as Record<string, unknown>),
                                  [level]: { ...slot, used: val },
                                },
                              },
                            });
                          }
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        )}
      </div>

      {confirmRest && (
        <ConfirmDialog
          title={
            confirmRest.kind === 'short'
              ? t('encounters.resourceTracker.confirmShortRest', {
                  name: confirmRest.characterName,
                  defaultValue: `Short Rest for ${confirmRest.characterName}`,
                })
              : t('encounters.resourceTracker.confirmLongRest', {
                  name: confirmRest.characterName,
                  defaultValue: `Long Rest for ${confirmRest.characterName}`,
                })
          }
          body={t('encounters.resourceTracker.confirmRestBody', {
            name: confirmRest.characterName,
            kind: confirmRest.kind,
            defaultValue: `Restoring resources and HP for ${confirmRest.characterName} using the server rest engine.`,
          })}
          confirmLabel={
            confirmRest.kind === 'short'
              ? t('encounters.resourceTracker.shortRest', 'Short Rest')
              : t('encounters.resourceTracker.longRest', 'Long Rest')
          }
          pendingLabel="Applying rest…"
          busy={restMutation.isPending}
          onConfirm={() => {
            const { characterId, kind } = confirmRest;
            setConfirmRest(null);
            restMutation.mutate({ characterId, kind });
          }}
          onCancel={() => setConfirmRest(null)}
        />
      )}
    </Card>
  );
}
