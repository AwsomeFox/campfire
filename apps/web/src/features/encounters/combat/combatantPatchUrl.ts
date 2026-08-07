/**
 * Issue #1992 (round 7, Devin): an unsaved statblock edit could be PATCHed to the WRONG
 * encounter on navigation.
 *
 * The whole-statblock save's last-chance flush fires from `CombatantRow`'s unmount
 * cleanup (`commitStatblockRef.current()`), which can run as part of the SAME commit that
 * applies a NEW `encounterId` route param to `RunSessionPage` — a route change does not
 * remount that page; it re-renders with the new id, then renders `null` for its children
 * while the new encounter loads, unmounting the OLD encounter's rows (this combatant row
 * included). `useMutation`'s returned `mutate`/`mutateAsync` functions all delegate to ONE
 * observer instance that persists across `RunSessionPage`'s own re-renders (only its
 * children unmount, not the page itself), and every render calls the equivalent of
 * `observer.setOptions(...)`, updating that shared instance's `mutationFn` IN PLACE — so
 * even a `mutateAsync` reference obtained from an OLD render's closure ends up invoking
 * whatever `mutationFn` the LATEST render most recently set, closing over the LATEST
 * (already-changed) encounter id. A PATCH built that way targets the NEW encounter with
 * the OLD (now foreign) combatant id, the server 404s (`fresh.encounterId !==
 * encounterId`), and because a rejected write intentionally leaves the statblock draft
 * `dirty` rather than discarding it (this issue's own recovery-on-rejection invariant),
 * the draft is lost anyway on a component that is mid-unmount and never gets a chance to
 * retry — the last-chance save loses the exact edit it exists to protect.
 *
 * The fix: never let the combatant PATCH's target encounter be resolved from anything
 * OUTSIDE this function's own arguments. `encounterId` must be a value the CALLER already
 * held explicitly (`CombatantRow`'s own `encounterId` prop, read normally at that row's own
 * last render — immune to the shared-observer staleness above, since it is an ordinary
 * prop, not something resolved through a persisting mutation object) — never a value read
 * back out of outer component state (e.g. a route param) at send time.
 */
export function combatantPatchUrl(apiBase: string, encounterId: number, combatantId: number): string {
  return `${apiBase}/encounters/${encounterId}/combatants/${combatantId}`;
}
