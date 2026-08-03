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
  restPendingKey,
  resourcePendingKey,
  slotPendingKey,
  pendingResourceKeys,
  type PipOwnerScope,
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
  encounterWritable,
}: {
  campaignId?: number;
  encounterId: number;
  characters: Character[];
  combatants: Combatant[];
  canDmWrite: boolean;
  canPlayerWrite: boolean;
  ownedCharacterIds: ReadonlySet<number>;
  /** `encounter.status !== 'ended'` (issue #1902 rework, round 2) — see the doc comment on
   *  {@link canEditCharacterResource} for why this only affects statblock-only combatants. */
  encounterWritable: boolean;
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
  // Issue #1902 rework: `CampaignProvider`'s campaign list loads asynchronously, so on
  // first paint `useCampaign(campaignId)` can still be `undefined` for a moment even
  // though `campaignId` itself is set — and `ruleSystemAdapter(undefined)` deliberately
  // falls back to 5e. Without this gate the panel would flash generic Short/Long Rest
  // buttons for a non-5e campaign before the real adapter (and its stamina/night, or
  // other, rest options) resolves. Only require resolution when a campaignId was
  // actually passed in.
  const campaignResolved = campaignId == null || campaign != null;

  const invalidate = () => {
    invalidateEncounter(queryClient, encounterId);
    if (campaignId != null) invalidateCampaignCharacters(queryClient, campaignId);
  };

  const restMutation = useMutation({
    mutationFn: async ({ characterId, kind }: { characterId: number; kind: RestOptionDef['type'] }) =>
      api.post<Character>(`${API}/characters/${characterId}/rest`, restRequestBody(kind)),
    // Issue #1902 rework (round 2): same reconciliation-before-invalidate fix as
    // slotMutation below. `POST .../rest` returns the fully-rested character (fresh
    // rpCurrent/spCurrent/hpCurrent/…) — without caching it here, `isPending` flips back
    // to false (re-enabling the buttons) before invalidate()'s background refetch lands,
    // so a Starfinder character who just spent their only RP on a Stamina Rest briefly
    // shows an enabled Stamina Rest button the server is guaranteed to reject next click
    // (and, in the other direction, a Night's Rest that restored RP can render the button
    // still disabled).
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
      expectedUpdatedAt,
    }: {
      characterId: number;
      level: number;
      currentUsed: number;
      used: number;
      expectedUpdatedAt: string;
    }) =>
      api.post<Character>(
        `${API}/characters/${characterId}/spell-slots`,
        spellSlotPatchBody(level, currentUsed, used, expectedUpdatedAt),
      ),
    // Issue #1902 rework: `spellSlotPatchBody` sends a DELTA relative to the `used` value
    // rendered on screen, protected by `expectedUpdatedAt` (a real server-side
    // compare-and-set — see that function's doc comment; a click-timing guard alone
    // cannot protect against an EXTERNAL write between render and request). If we waited
    // for `invalidate()`'s background refetch to land before trusting `slot.used` again,
    // a second click on THIS client in that window would also compute its delta against
    // the stale pre-write value. The POST response IS the fresh character
    // (server-authoritative `spellSlots`), so write it into the cache synchronously,
    // before the query has any chance to be read again — this closes that second-order
    // race too, without a debounce or a second round-trip.
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
      // Issue #1902 rework (round 4): the resource `key` or spell-slot `level` (as a
      // string) this write targets, so `pendingResourceKeys` can scope the pending state
      // to the one pip that's actually in flight rather than every pip on this combatant.
      targetKey: string;
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

  // Issue #1902 rework (round 4): scoped per-control pending state — see
  // `pendingResourceKeys`'s doc comment for why a blanket OR of all four mutations'
  // `isPending` was disabling every combatant's controls for the duration of any single
  // in-flight write anywhere in the panel.
  const pendingKeys = pendingResourceKeys({
    rest: { isPending: restMutation.isPending, variables: restMutation.variables },
    resource: { isPending: resourceMutation.isPending, variables: resourceMutation.variables },
    slot: { isPending: slotMutation.isPending, variables: slotMutation.variables },
    statblock: { isPending: statblockMutation.isPending, variables: statblockMutation.variables },
  });

  const rows = combatants
    .map((c) => {
      let resources: Record<string, CharacterResource> = {};
      let spellSlots: Record<string, SpellSlotLevel> = {};
      // Issue #1902 rework: always the COMBATANT's own name, never the linked character
      // sheet's name. A DM can rename a fighter for this encounter (duplicate PCs,
      // disguises, "Vesh (charmed)") via `patchCombatant`; overriding it here made this
      // panel the one place in the fight that disagreed with the combatant list,
      // initiative order, and combat log.
      const name = c.name;
      // Stamina rests spend a Resolve Point (issue #1902 rework) — mirrors the same
      // `rpCurrent < 1` guard CharacterPage's RestControls already applies, so this
      // panel doesn't offer a rest button the server is guaranteed to reject.
      let rpCurrent: number | undefined;
      // The character sheet's `updatedAt` at render time (issue #1902 rework, round 4) —
      // echoed back as `expectedUpdatedAt` on a spell-slot write so the server can reject
      // a delta computed against state another client has since changed. Statblock-only
      // combatants have no sheet, so no CAS token; that write path isn't delta-based
      // anyway (it PATCHes the whole statblock object).
      let updatedAt: string | undefined;

      if (c.kind === 'character' && c.characterId) {
        const char = characters.find((ch) => ch.id === c.characterId);
        if (char) {
          resources = char.resources;
          spellSlots = char.spellSlots;
          rpCurrent = char.rpCurrent;
          updatedAt = char.updatedAt;
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
        encounterWritable,
      });

      // Issue #1902 rework (round 4): which pending-key namespace this row's writes fall
      // into — the character sheet if linked, else this statblock combatant itself.
      const scope: PipOwnerScope = c.kind === 'character' && c.characterId != null ? { characterId: c.characterId } : { combatantId: c.id };

      return { combatant: c, name, resources, spellSlots, canEdit, rpCurrent, updatedAt, scope };
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
        {rows.map(({ combatant: c, name, resources, spellSlots, canEdit, rpCurrent, updatedAt, scope }) => (
          <div key={c.id} className="border-t pt-2 mt-2 first:mt-0 first:border-0 first:pt-0">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="font-medium">{name}</div>
              {canEdit && c.kind === 'character' && c.characterId != null && campaignResolved && restOptions.length > 0 && (
                <div className="flex gap-2">
                  {restOptions.map((opt) => (
                    <Btn
                      key={opt.type}
                      density="compact"
                      disabled={pendingKeys.has(restPendingKey(c.characterId as number)) || (opt.type === 'stamina' && rpCurrent != null && rpCurrent < 1)}
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
                        disabled={!canEdit || pendingKeys.has(resourcePendingKey(scope, key))}
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
                              targetKey: key,
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
                      disabled={!canEdit || pendingKeys.has(slotPendingKey(scope, Number(level)))}
                      onChange={(val) => {
                        if (!canEdit) return;
                        if (c.kind === 'character' && c.characterId) {
                          slotMutation.mutate({
                            characterId: c.characterId,
                            level: Number(level),
                            currentUsed: slot.used,
                            used: val,
                            // Always set together with `spellSlots` from the same `char`
                            // read in the row builder above — see that comment.
                            expectedUpdatedAt: updatedAt as string,
                          });
                        } else if (c.statblock) {
                          const sb = c.statblock as unknown as Record<string, unknown>;
                          statblockMutation.mutate({
                            combatantId: c.id,
                            statblock: { ...c.statblock, spellSlots: { ...(sb.spellSlots as Record<string, unknown>), [level]: { ...slot, used: val } } },
                            kind: 'slot',
                            targetKey: level,
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
