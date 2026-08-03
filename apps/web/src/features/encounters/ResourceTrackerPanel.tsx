import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ruleSystemAdapter, restOptionsForAdapter } from '@campfire/schema';
import type { Character, Combatant, CharacterResource, EncounterWithCombatants, RestOptionDef, SpellSlotLevel } from '@campfire/schema';
import { Card, Btn, ErrorNote } from '../../components/ui';
import { api, API, translateApiError, isAmbiguousMutation, isStaleWrite } from '../../lib/api';
import { invalidateEncounter, invalidateCampaignCharacters, queryKeys } from '../../lib/query';
import { useCampaign } from '../../app/CampaignContext';
import {
  restRequestBody,
  resourcePatchBody,
  spellSlotPatchBody,
  canEditCharacterResource,
  hasTrackedResources,
  pendingTargetKey,
  addPendingKey,
  removePendingKey,
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
  encounterUpdatedAt,
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
  /** The encounter's own `updatedAt` (issue #1902 rework, round 12, devin) — echoed back as
   *  `expectedUpdatedAt` on a statblock pip write. `updateCombatant` validates this CAS token
   *  against the ENCOUNTER row, not a per-combatant one (there is no per-combatant revision
   *  field), so this is the same guard every other `expectedUpdatedAt`-bearing combatant PATCH
   *  in the app already relies on. Without it, a whole-statblock PATCH built from a stale
   *  cached combatant could silently overwrite another client's concurrent statblock edit. */
  encounterUpdatedAt: string | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // Issue #1902 rework (round 12, codex P2): keyed to the TARGET that raised it, not a bare
  // string — otherwise an unrelated mutation's success (`setError(null)` for a DIFFERENT
  // character/combatant) silently cleared a still-relevant failure the user has not acted on
  // yet. A NEWER failure from any target still replaces whatever is shown (the most recent
  // failure is the most actionable one); a success only clears the banner when it belongs to
  // the SAME target currently displayed.
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const clearErrorFor = (key: string) => setError((prev) => (prev?.key === key ? null : prev));
  const setErrorFor = (key: string, message: string) => setError({ key, message });

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

  // Issue #1902 rework (round 5, key granularity corrected in round 6): pending
  // identities are tracked in OUR OWN state via each mutation's `onMutate`/`onSettled`,
  // not derived from a `useMutation` hook's `isPending`/`variables` (round 4's
  // approach — `isPending`/`variables` describe only the SINGLE MOST RECENT call on a
  // hook, so two concurrent same-kind mutations lost track of the first). Keyed per
  // TARGET (one character sheet, or one statblock combatant), not per resource/slot —
  // see `pendingTargetKey`'s doc comment for why finer-than-target scoping (round 4/5)
  // let two writes to the SAME row race past each other and corrupt or falsely reject
  // one another.
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const beginPending = (key: string) => setPendingKeys((prev) => addPendingKey(prev, key));
  const endPending = (key: string) => setPendingKeys((prev) => removePendingKey(prev, key));
  // Issue #1902 rework (round 9, widened round 12 P2): an AMBIGUOUS mutation outcome (the
  // write's response was lost — a timeout, a network drop — so the client cannot tell
  // whether it landed server-side) must NOT release the control the instant the promise
  // settles the way an ordinary rejection does. A definite 400/403 is a reliable "did not
  // apply" answer; an ambiguous one is not, and releasing the pip/button anyway invites
  // exactly the retry the encounter workflow's own `isAmbiguousOutcome` reconciliation
  // guard exists to prevent elsewhere on this page — for an irreplaceable resource (a
  // Stamina Rest's RP, a spell slot, a hit die) a "harmless" retry after a lost response
  // can silently spend it twice.
  //
  // A definite 409 STALE_WRITE is NOT ambiguous (the write definitely did not apply), but
  // it is not safe to release immediately either: the row DID change server-side, yet this
  // render's local snapshot (the `used`/`updatedAt` the control still shows) is the OLD,
  // now-rejected one. Releasing the control right away re-enables it with that same stale
  // value and token, guaranteeing an immediate retry computes the identical delta and fails
  // the identical way. Both cases therefore wait for a fresh read of BOTH caches this panel
  // renders from before releasing the pending key, so the control's next render reflects
  // server-truth rather than the pre-request snapshot.
  const endPendingAfterReconciling = async (key: string, error: unknown) => {
    if (error && (isAmbiguousMutation(error) || isStaleWrite(error))) {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: queryKeys.encounter(encounterId) }),
        campaignId != null ? queryClient.invalidateQueries({ queryKey: queryKeys.campaignCharacters(campaignId) }) : Promise.resolve(),
        campaignId != null ? queryClient.invalidateQueries({ queryKey: queryKeys.campaignParty(campaignId) }) : Promise.resolve(),
      ]);
    }
    endPending(key);
  };

  // Every write reconciles the ROW it touched into the relevant cache from its OWN
  // response, before `invalidate()`'s async refetch (issue #1902 rework): round 1 did
  // this for slotMutation, round 2 for restMutation, round 5 for resourceMutation.
  // `reconcileCombatant` (round 6) is the statblock-side equivalent — `statblockMutation`
  // was the one write path still relying on `invalidate()` alone, so the SAME defect
  // class (self-inflicted revert from a stale local snapshot) applied to a monster's
  // combatant row that applied to a character's sheet before round 5.
  const reconcileCharacter = (updated: Character) => {
    if (campaignId != null) {
      queryClient.setQueryData<Character[]>(queryKeys.campaignCharacters(campaignId), (old) =>
        old?.map((c) => (c.id === updated.id ? updated : c)),
      );
    }
  };
  const reconcileCombatant = (updated: Combatant) => {
    queryClient.setQueryData<EncounterWithCombatants>(queryKeys.encounter(encounterId), (old) =>
      old ? { ...old, combatants: old.combatants.map((c) => (c.id === updated.id ? updated : c)) } : old,
    );
  };

  const restMutation = useMutation({
    mutationFn: async ({ characterId, kind }: { characterId: number; kind: RestOptionDef['type'] }) =>
      api.post<Character>(`${API}/characters/${characterId}/rest`, restRequestBody(kind)),
    onMutate: (vars) => beginPending(pendingTargetKey({ characterId: vars.characterId })),
    onSettled: (_data, error, vars) => endPendingAfterReconciling(pendingTargetKey({ characterId: vars.characterId }), error),
    onSuccess: (updated, vars) => {
      clearErrorFor(pendingTargetKey({ characterId: vars.characterId }));
      reconcileCharacter(updated);
      invalidate();
    },
    onError: (err, vars) => {
      setErrorFor(pendingTargetKey({ characterId: vars.characterId }), translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.restError' }));
      invalidate();
    },
  });

  const resourceMutation = useMutation({
    mutationFn: async ({ characterId, key, used }: { characterId: number; key: string; used: number }) =>
      api.post<Character>(`${API}/characters/${characterId}/resources`, resourcePatchBody(key, used)),
    onMutate: (vars) => beginPending(pendingTargetKey({ characterId: vars.characterId })),
    onSettled: (_data, error, vars) => endPendingAfterReconciling(pendingTargetKey({ characterId: vars.characterId }), error),
    onSuccess: (updated, vars) => {
      clearErrorFor(pendingTargetKey({ characterId: vars.characterId }));
      reconcileCharacter(updated);
      invalidate();
    },
    onError: (err, vars) => {
      setErrorFor(pendingTargetKey({ characterId: vars.characterId }), translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.updateResourceError' }));
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
      // `string | undefined` (issue #1902 rework, round 7), matching
      // `spellSlotPatchBody`'s own parameter and the schema's optional
      // `ExpectedUpdatedAt` — see that function's doc comment.
      expectedUpdatedAt: string | undefined;
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
    onMutate: (vars) => beginPending(pendingTargetKey({ characterId: vars.characterId })),
    onSettled: (_data, error, vars) => endPendingAfterReconciling(pendingTargetKey({ characterId: vars.characterId }), error),
    onSuccess: (updated, vars) => {
      clearErrorFor(pendingTargetKey({ characterId: vars.characterId }));
      reconcileCharacter(updated);
      invalidate();
    },
    onError: (err, vars) => {
      setErrorFor(pendingTargetKey({ characterId: vars.characterId }), translateApiError(err, t, { fallbackKey: 'encounters.resourceTracker.updateSlotError' }));
      invalidate();
    },
  });

  const statblockMutation = useMutation({
    mutationFn: async ({
      combatantId,
      statblock,
      expectedUpdatedAt,
    }: {
      combatantId: number;
      statblock: Record<string, unknown>;
      // Issue #1902 rework: this one mutation backs both statblock resource pips and
      // statblock spell-slot pips. `kind` lets `onError` pick the fallback message that
      // matches which control actually failed, instead of always reporting "resource".
      kind: 'resource' | 'slot';
      // Issue #1902 rework (round 12, devin): the encounter's `updatedAt` as last read —
      // see the doc comment on the `encounterUpdatedAt` prop. A whole-statblock PATCH built
      // from a stale cached combatant must not silently clobber a concurrent statblock edit.
      expectedUpdatedAt: string | undefined;
    }) => api.patch<Combatant>(`${API}/encounters/${encounterId}/combatants/${combatantId}`, { statblock, expectedUpdatedAt }),
    onMutate: (vars) => beginPending(pendingTargetKey({ combatantId: vars.combatantId })),
    onSettled: (_data, error, vars) => endPendingAfterReconciling(pendingTargetKey({ combatantId: vars.combatantId }), error),
    onSuccess: (updated, vars) => {
      clearErrorFor(pendingTargetKey({ combatantId: vars.combatantId }));
      reconcileCombatant(updated);
      invalidate();
    },
    onError: (err, variables) => {
      const fallbackKey =
        variables.kind === 'slot' ? 'encounters.resourceTracker.updateSlotError' : 'encounters.resourceTracker.updateResourceError';
      setErrorFor(pendingTargetKey({ combatantId: variables.combatantId }), translateApiError(err, t, { fallbackKey }));
      invalidate();
    },
  });

  const rowsAll = combatants
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
    });

  // Issue #1902 rework (round 11, devin): the PANEL-level gate is kept independent of the
  // per-row filter below and still checks resources/spellSlots only, matching the
  // acceptance criterion ("renders nothing when NO combatant has resources or spell
  // slots") — a row kept below ONLY for its rest buttons must not, by itself, keep an
  // otherwise-empty panel visible.
  if (!rowsAll.some((row) => hasTrackedResources(row.resources, row.spellSlots))) return null;

  // A row is worth showing either because it has Features/Spell Slots to display, OR
  // because it's an editable character-linked combatant that CAN be rested — a martial
  // with an empty resources/spellSlots map (no hit-dice entry seeded yet, or never
  // written to) still needs its rest buttons to appear, since resting is valid for them
  // too. Filtering by `hasTrackedResources` alone dropped the row (and, with it, the
  // rest buttons this PR exists to wire up) for exactly that character.
  const rows = rowsAll.filter(
    (row) => hasTrackedResources(row.resources, row.spellSlots) || (row.combatant.kind === 'character' && row.combatant.characterId != null && row.canEdit && campaignResolved && restOptions.length > 0),
  );

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="font-semibold text-lg min-w-0 break-words">{t('encounters.resourceTracker.title', { defaultValue: 'Resource Tracker' })}</h3>
        {canDmWrite && campaignId != null && (
          <Link to={`/c/${campaignId}/party`} className="text-xs font-medium underline opacity-80 hover:opacity-100 shrink-0" data-testid="resource-tracker-party-rest-link">
            {t('encounters.resourceTracker.partyRest', { defaultValue: 'Party Rest' })} →
          </Link>
        )}
      </div>

      {error && (
        <ErrorNote message={error.message} onDismiss={() => setError(null)} />
      )}

      <div className="space-y-4 max-h-96 overflow-y-auto">
        {rows.map(({ combatant: c, name, resources, spellSlots, canEdit, rpCurrent, updatedAt, scope }) => (
          <div key={c.id} className="border-t pt-2 mt-2 first:mt-0 first:border-0 first:pt-0">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <div className="font-medium min-w-0 break-words">{name}</div>
              {canEdit && c.kind === 'character' && c.characterId != null && campaignResolved && restOptions.length > 0 && (
                // Issue #762 rework: `flex-wrap` — a Starfinder character's rest labels
                // ("⚡ Stamina Rest (1 RP)", "🌙 Night's Rest") are noticeably longer than
                // 5e's "Short Rest"/"Long Rest", and this row had no wrap fallback. At the
                // tablet-width DM cockpit (which already has no spare width, #1455/#1510),
                // an unwrapped long name + two long rest buttons could force this row (and
                // anything relying on its parent's min-content width) wider than the
                // viewport. Wrapping here keeps the row's own width bounded instead of
                // pushing unrelated page chrome off-screen.
                <div className="flex gap-2 flex-wrap">
                  {restOptions.map((opt) => (
                    <Btn
                      key={opt.type}
                      density="compact"
                      disabled={pendingKeys.has(pendingTargetKey(scope)) || (opt.type === 'stamina' && rpCurrent != null && rpCurrent < 1)}
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
                    <div key={key} className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="text-sm min-w-0 break-words">
                        {res.name || key}
                        {res.recharge && <span className="ml-2 text-xs opacity-70">({res.recharge})</span>}
                        {sourceText && <span className="ml-2 text-xs opacity-70">[{sourceText}]</span>}
                      </div>
                      <Pips
                        max={res.max}
                        used={res.used}
                        disabled={!canEdit || pendingKeys.has(pendingTargetKey(scope))}
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
                              expectedUpdatedAt: encounterUpdatedAt,
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
                  <div key={level} className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="text-sm min-w-0 break-words">{t('encounters.resourceTracker.level', { level, defaultValue: `Level ${level}` })}</div>
                    <Pips
                      max={slot.max}
                      used={slot.used}
                      disabled={!canEdit || pendingKeys.has(pendingTargetKey(scope))}
                      onChange={(val) => {
                        if (!canEdit) return;
                        if (c.kind === 'character' && c.characterId) {
                          slotMutation.mutate({
                            characterId: c.characterId,
                            level: Number(level),
                            currentUsed: slot.used,
                            used: val,
                            // No cast (issue #1902 rework, round 7): `updatedAt` is
                            // `string | undefined` here honestly — it's set together
                            // with `spellSlots` from the same `char` read in the row
                            // builder above whenever a linked character was actually
                            // found, but stays `undefined` if it wasn't (data still
                            // loading, or a stale combatant->character link). Letting
                            // `undefined` flow through to `spellSlotPatchBody` means
                            // that rare case degrades to the documented unconditional
                            // write instead of a cast lying to the type checker.
                            expectedUpdatedAt: updatedAt,
                          });
                        } else if (c.statblock) {
                          const sb = c.statblock as unknown as Record<string, unknown>;
                          statblockMutation.mutate({
                            combatantId: c.id,
                            statblock: { ...c.statblock, spellSlots: { ...(sb.spellSlots as Record<string, unknown>), [level]: { ...slot, used: val } } },
                            kind: 'slot',
                            expectedUpdatedAt: encounterUpdatedAt,
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
