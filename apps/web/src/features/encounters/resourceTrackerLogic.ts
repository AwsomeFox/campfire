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
 * `{ level, delta }`, not `{ [level]: { used, max } }`. `delta` is relative to the
 * slot's current `used`, so the panel (which only knows the target `used`) must convert.
 * Typed against the shared `SpellSlotPatch` contract for the same reason as
 * {@link resourcePatchBody}.
 */
export function spellSlotPatchBody(level: number, currentUsed: number, nextUsed: number): SpellSlotPatch {
  const body: SpellSlotPatch = { level, delta: nextUsed - currentUsed };
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
