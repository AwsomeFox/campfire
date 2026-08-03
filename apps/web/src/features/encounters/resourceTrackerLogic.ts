/**
 * Pure helpers for {@link ResourceTrackerPanel} (issue #1902), split out so the request
 * bodies and the gating matrix can be unit-tested without rendering the component.
 */
import type { ResourcePatch, RestOptionDef, SpellSlotPatch } from '@campfire/schema';

/**
 * Body for `POST /characters/:id/rest`. `kind` is `RestOptionDef['type']` — the same
 * `'short' | 'long' | 'stamina' | 'night'` union the server's `RestPatch` DTO accepts —
 * rather than a locally-invented `'short' | 'long'` literal, so a caller driven by
 * `restOptionsForAdapter` (Starfinder's `stamina`/`night` cadence included) type-checks
 * without a cast. `RestPatch` itself is server-only (not re-exported from
 * `@campfire/schema`, unlike `ResourcePatch`/`SpellSlotPatch`), so `RestOptionDef['type']`
 * is the closest shared source of truth for this shape.
 */
export function restRequestBody(kind: RestOptionDef['type']): { type: RestOptionDef['type'] } {
  return { type: kind };
}

/**
 * Body for `POST /characters/:id/resources` — `ResourcePatch.strict()` is flat
 * (`{ key, used?, ... }`), NOT `{ [key]: { used, max } }`. Sending the nested shape is a
 * guaranteed 400 (issue #1902's root defect). Typed against the shared `ResourcePatch`
 * contract (rather than a locally re-declared `{ key, used }` shape) so a future change to
 * that contract's field names surfaces here as a type error instead of a silent 400 at
 * runtime — the schema-source-of-truth rule AGENTS.md documents.
 */
export function resourcePatchBody(key: string, nextUsed: number): Pick<ResourcePatch, 'key' | 'used'> {
  const body: Pick<ResourcePatch, 'key' | 'used'> = { key, used: nextUsed };
  return body;
}

/**
 * Body for `POST /characters/:id/spell-slots` — `SpellSlotPatch.strict()` is
 * `{ level, delta, expectedUpdatedAt? }`, not `{ [level]: { used, max } }`. `delta` is
 * relative to the slot's current `used`, so the panel (which only knows the target
 * `used`) must convert. Typed against the shared `SpellSlotPatch` contract for the same
 * reason as {@link resourcePatchBody}.
 *
 * `delta` alone is NOT enough to protect this write from a concurrent change (issue #1902
 * rework, third review pass on this exact defect): if another client spends or restores
 * this slot between when THIS client last rendered `currentUsed` and when this request
 * arrives, the server would apply this delta on top of a value the caller never saw. The
 * round-1 fix (reconciling the query cache from a mutation's own response) closes the gap
 * between one client's OWN successive clicks, but cannot protect against an external
 * write — there is no "own response" to reconcile from until AFTER the race has already
 * either landed correctly or corrupted the count. `expectedUpdatedAt` (the character's
 * `updatedAt` at the moment `currentUsed` was read) makes the server verify nothing else
 * changed the sheet first: a mismatch is rejected with 409 `STALE_WRITE` instead of being
 * silently mis-applied. This is a real compare-and-set, not a client-side mitigation.
 */
export function spellSlotPatchBody(
  level: number,
  currentUsed: number,
  nextUsed: number,
  expectedUpdatedAt: string,
): SpellSlotPatch {
  const body: SpellSlotPatch = { level, delta: nextUsed - currentUsed, expectedUpdatedAt };
  return body;
}

/**
 * Whether the current viewer may interact with a combatant's pips/rest controls (issue
 * #1902 acceptance criterion 3). Mirrors the server's dm-or-owner rule
 * (`CharactersService.assertCanWrite`) for UX only — the server remains authoritative.
 * A statblock-only combatant (no `characterId`) has no "owner", so only the DM can edit it.
 *
 * `encounterWritable` (issue #1902 rework, round 2) gates ONLY the statblock branch
 * (`characterId == null`): a statblock combatant's pips write through
 * `PATCH /encounters/:id/combatants/:id`, which `EncountersService.assertMutable` rejects
 * with 409 once the encounter has ended. A character-linked combatant's pips write to the
 * CHARACTER SHEET (`POST /characters/:id/resources` / `.../spell-slots` / `.../rest`),
 * which has no encounter-status dependency at all — resting or spending a resource on your
 * own sheet is still meaningful after the fight is over — so `encounterWritable` must NOT
 * disable those.
 */
export function canEditCharacterResource(opts: {
  canDmWrite: boolean;
  canPlayerWrite: boolean;
  characterId: number | null | undefined;
  ownedCharacterIds: ReadonlySet<number>;
  encounterWritable: boolean;
}): boolean {
  if (opts.characterId == null && !opts.encounterWritable) return false;
  if (opts.canDmWrite) return true;
  if (!opts.canPlayerWrite) return false;
  return opts.characterId != null && opts.ownedCharacterIds.has(opts.characterId);
}

/** Acceptance criterion: render nothing when no combatant has resources or spell slots. */
export function hasTrackedResources(
  resources: Record<string, unknown>,
  spellSlots: Record<string, unknown>,
): boolean {
  return Object.keys(resources).length > 0 || Object.keys(spellSlots).length > 0;
}

/** The character sheet or statblock combatant a resource/slot pip belongs to. */
export type PipOwnerScope = { characterId: number } | { combatantId: number };

/** Identity of ONE character-linked combatant's rest controls. */
export function restPendingKey(characterId: number): string {
  return `rest:${characterId}`;
}

/** Identity of ONE resource pip, scoped to its owning character sheet or statblock combatant. */
export function resourcePendingKey(scope: PipOwnerScope, key: string): string {
  return 'characterId' in scope ? `resource:char:${scope.characterId}:${key}` : `resource:combatant:${scope.combatantId}:${key}`;
}

/** Identity of ONE spell-slot pip, scoped the same way as {@link resourcePendingKey}. */
export function slotPendingKey(scope: PipOwnerScope, level: number): string {
  return 'characterId' in scope ? `slot:char:${scope.characterId}:${level}` : `slot:combatant:${scope.combatantId}:${level}`;
}

/**
 * Derives which controls are currently in flight from each `useMutation` hook's own
 * `isPending`/`variables` (issue #1902 rework, round 4). React Query's `isPending` is per
 * MUTATION HOOK, not per write target, so the previous blanket
 * `restMutation.isPending || resourceMutation.isPending || slotMutation.isPending ||
 * statblockMutation.isPending` disabled every control for every combatant for the
 * duration of ANY single in-flight write — a slow save for one character at a live table
 * visibly locked out every other player's controls too. Each control instead disables
 * only when ITS OWN identity ({@link restPendingKey} / {@link resourcePendingKey} /
 * {@link slotPendingKey}) is in the returned set. Takes plain `{ isPending, variables }`
 * descriptors rather than the real `UseMutationResult` objects so this stays a pure,
 * render-independent function — the component passes each mutation's own two fields.
 */
export function pendingResourceKeys(mutations: {
  rest?: { isPending: boolean; variables?: { characterId: number } };
  resource?: { isPending: boolean; variables?: { characterId: number; key: string } };
  slot?: { isPending: boolean; variables?: { characterId: number; level: number } };
  statblock?: {
    isPending: boolean;
    variables?: { combatantId: number; kind: 'resource' | 'slot'; targetKey: string };
  };
}): ReadonlySet<string> {
  const keys = new Set<string>();
  if (mutations.rest?.isPending && mutations.rest.variables) {
    keys.add(restPendingKey(mutations.rest.variables.characterId));
  }
  if (mutations.resource?.isPending && mutations.resource.variables) {
    keys.add(resourcePendingKey({ characterId: mutations.resource.variables.characterId }, mutations.resource.variables.key));
  }
  if (mutations.slot?.isPending && mutations.slot.variables) {
    keys.add(slotPendingKey({ characterId: mutations.slot.variables.characterId }, mutations.slot.variables.level));
  }
  if (mutations.statblock?.isPending && mutations.statblock.variables) {
    const v = mutations.statblock.variables;
    if (v.kind === 'resource') {
      keys.add(resourcePendingKey({ combatantId: v.combatantId }, v.targetKey));
    } else {
      keys.add(slotPendingKey({ combatantId: v.combatantId }, Number(v.targetKey)));
    }
  }
  return keys;
}
