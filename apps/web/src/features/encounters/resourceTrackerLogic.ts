/**
 * Pure helpers for {@link ResourceTrackerPanel} (issue #1902), split out so the request
 * bodies and the gating matrix can be unit-tested without rendering the component.
 */

/** Body for `POST /characters/:id/rest` — mirrors `RestPatch` in characters.dto.ts. */
export function restRequestBody(kind: 'short' | 'long'): { type: 'short' | 'long' } {
  return { type: kind };
}

/**
 * Body for `POST /characters/:id/resources` — `ResourcePatch.strict()` is flat
 * (`{ key, used?, ... }`), NOT `{ [key]: { used, max } }`. Sending the nested shape is a
 * guaranteed 400 (issue #1902's root defect).
 */
export function resourcePatchBody(key: string, nextUsed: number): { key: string; used: number } {
  return { key, used: nextUsed };
}

/**
 * Body for `POST /characters/:id/spell-slots` — `SpellSlotPatch.strict()` is
 * `{ level, delta }`, not `{ [level]: { used, max } }`. `delta` is relative to the
 * slot's current `used`, so the panel (which only knows the target `used`) must convert.
 */
export function spellSlotPatchBody(
  level: number,
  currentUsed: number,
  nextUsed: number,
): { level: number; delta: number } {
  return { level, delta: nextUsed - currentUsed };
}

/**
 * Whether the current viewer may interact with a character-linked combatant's pips/rest
 * controls (issue #1902 acceptance criterion 3). Mirrors the server's dm-or-owner rule
 * (`CharactersService.assertCanWrite`) for UX only — the server remains authoritative.
 * A statblock-only combatant (no `characterId`) has no "owner", so only the DM can edit it.
 */
export function canEditCharacterResource(opts: {
  canDmWrite: boolean;
  canPlayerWrite: boolean;
  characterId: number | null | undefined;
  ownedCharacterIds: ReadonlySet<number>;
}): boolean {
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
