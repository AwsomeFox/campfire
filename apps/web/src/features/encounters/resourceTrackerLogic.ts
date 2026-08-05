/**
 * Pure helpers for {@link ResourceTrackerPanel} (issue #1902), split out so the request
 * bodies and the gating matrix can be unit-tested without rendering the component.
 */
import type { CombatantResourceAdjust, ResourcePatch, RestOptionDef, SpellSlotPatch } from '@campfire/schema';

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
 *
 * `expectedUpdatedAt` (issue #1902 rework, round 24, codex P1) protects this write for the
 * SAME reason {@link spellSlotPatchBody} carries it, more acutely: `used` here is an
 * ABSOLUTE overwrite, not a delta, so without a revision guard a concurrent spend/rest from
 * another tab, a REST client, or an MCP caller between this client's read and this request
 * is silently undone the instant this write lands — not merely mis-applied on top of stale
 * data, but a full round trip THROUGH `adjustResource`'s own read-modify-write that discards
 * the other writer's change entirely. See that function's doc comment for the full
 * compare-and-set rationale; this is the identical guard, applied to the sibling contract.
 */
export function resourcePatchBody(
  key: string,
  nextUsed: number,
  expectedUpdatedAt: string | undefined,
): Pick<ResourcePatch, 'key' | 'used' | 'expectedUpdatedAt'> {
  const body: Pick<ResourcePatch, 'key' | 'used' | 'expectedUpdatedAt'> = { key, used: nextUsed, expectedUpdatedAt };
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
 *
 * `expectedUpdatedAt` is typed `string | undefined`, matching the schema's own
 * `ExpectedUpdatedAt` optionality (issue #1902 rework, round 7) rather than a bare
 * `string` a caller would have to lie to via an `as string` cast if the character
 * hasn't resolved yet (data still loading, or a combatant with no matching character
 * row). `undefined` reaches the server as an omitted field, which is the documented
 * unconditional-write fallback every other caller of this contract already gets —
 * honest, not a silent gap.
 */
export function spellSlotPatchBody(
  level: number,
  currentUsed: number,
  nextUsed: number,
  expectedUpdatedAt: string | undefined,
): SpellSlotPatch {
  const body: SpellSlotPatch = { level, delta: nextUsed - currentUsed, expectedUpdatedAt };
  return body;
}

/**
 * Body for `POST /encounters/:id/combatants/:cid/resources` (issue #1909) — the
 * combatant-scoped counterpart to {@link resourcePatchBody}/{@link spellSlotPatchBody},
 * for a monster/NPC statblock pip. `CombatantResourceAdjust.strict()` is
 * `{ key, delta }` XOR `{ spellLevel, delta }`, not `{ [key]: { used, max } }` — sending
 * the nested shape (the whole-statblock PATCH this replaces used to build) is a
 * guaranteed 400. `target` is exactly one of `{ key }` or `{ spellLevel }`; `delta` is
 * computed relative to the rendered `currentUsed`, matching {@link spellSlotPatchBody}.
 *
 * No whole-encounter `expectedUpdatedAt`/CAS token: unlike the whole-statblock PATCH, this
 * endpoint reads the combatant row fresh inside its own transaction, so a second writer's
 * write never gets silently overwritten by a stale whole-blob PATCH. But `currentUsed` IS
 * still sent as `expectedUsed` (issue #1909 review, Codex P2) — a DIFFERENT race the fresh
 * row-read does NOT close: a pip click is an ABSOLUTE intent ("set used to N") converted
 * to a relative `delta` against whatever `used` THIS client last rendered. If two clients
 * both last rendered `used: 0` and both click the first pip, both send `delta: 1`; the
 * transactional read makes each write internally consistent, but nothing stops the SECOND
 * caller's delta from applying on top of the FIRST's fresh result (committing `used: 2`,
 * not the `1` either caller intended). `expectedUsed` closes that: the server verifies it
 * against the FRESH value inside its own transaction and 409s on a mismatch instead of
 * applying a delta computed from a baseline that has since moved.
 */
export function combatantResourceAdjustBody(
  target: { key: string } | { spellLevel: number },
  currentUsed: number,
  nextUsed: number,
): Pick<CombatantResourceAdjust, 'key' | 'spellLevel' | 'delta' | 'expectedUsed'> {
  return { ...target, delta: nextUsed - currentUsed, expectedUsed: currentUsed };
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

/** The character sheet or statblock combatant a resource/slot/rest control belongs to. */
export type PipOwnerScope = { characterId: number } | { combatantId: number };

/**
 * Identity of every pending-tracked control on ONE target (a character sheet, or a
 * statblock-only combatant) — issue #1902 rework, round 6.
 *
 * Rounds 4/5 keyed pending state per RESOURCE/SLOT (`resource:char:1:rage` vs.
 * `slot:char:1:2`), which correctly let a different combatant's controls stay responsive
 * (round 4's ask) and correctly tracked multiple concurrent same-kind mutations (round
 * 5's fix). But it ALSO let two DIFFERENT writes to the SAME character/combatant run
 * concurrently — and both a character sheet and a statblock combatant have exactly ONE
 * revision token / ONE saved object, shared across every resource, slot, and rest control
 * on that row:
 *
 *   - a character's `expectedUpdatedAt` CAS token is the SHEET's `updatedAt`, not a
 *     per-resource one — a resource write and a spell-slot write on the SAME character
 *     racing past each other means the second one's token is stale by the time it lands,
 *     rejected with a "someone else changed this" the user never caused (their own prior
 *     click did);
  *   - (historically) a statblock combatant's resource/slot writes each PATCHed the ENTIRE
 *     saved `statblock` object rebuilt from whatever this client currently had cached — two
 *     such writes racing past each other meant the second was composed from a snapshot
 *     that didn't yet include the first's change, and silently reverted it on success.
 *
 * Collapsing the key to the TARGET (not the specific resource/slot) serializes every
 * control on that one character sheet, or that one statblock combatant, against each
 * other, while a DIFFERENT character/combatant remains fully independent. Issue #1909
 * replaced the statblock branch's whole-statblock PATCH with the delta-based, per-
 * combatant `POST .../combatants/:cid/resources` (no shared CAS token, no lost-update
 * race even across concurrent writers), so statblock combatants now map to their OWN
 * `combatant:<id>` key instead of a single encounter-wide one — a DM spending one
 * monster's Ki pip no longer disables every other monster's pips in the same encounter.
 */
export function pendingTargetKey(scope: PipOwnerScope): string {
  return 'characterId' in scope ? `char:${scope.characterId}` : `combatant:${scope.combatantId}`;
}

/**
 * Add `key` to a pending-control set, returning a NEW set (issue #1902 rework, round 5).
 *
 * Round 4 derived the pending set from each `useMutation` HOOK's own `isPending`/
 * `variables` — but those two fields describe only the SINGLE MOST RECENT call on that
 * hook. Firing a second `mutate()` on the same hook (e.g. resting Alice, then Bob, before
 * Alice's request settles) makes the hook's `variables` flip to Bob's — so Alice's control
 * read as "not pending" and re-enabled while her request was still in flight server-side,
 * letting a second click fire on top of it. `onMutate`/`onSettled` (unlike `isPending`/
 * `variables`) fire once per INVOCATION of `mutate()`, each with that call's own
 * variables, so tracking pending identities through them (adding here, removing in
 * {@link removePendingKey}) correctly represents however many of the SAME mutation kind
 * are genuinely in flight at once — not just the newest.
 */
export function addPendingKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (keys.has(key)) return keys;
  const next = new Set(keys);
  next.add(key);
  return next;
}

/** Remove `key` from a pending-control set, returning a NEW set. Companion to {@link addPendingKey}. */
export function removePendingKey(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!keys.has(key)) return keys;
  const next = new Set(keys);
  next.delete(key);
  return next;
}
