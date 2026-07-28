/**
 * Leveled condition tracks (issue #1643): ONE named condition per system whose severity is
 * an escalating integer LEVEL — 5e Exhaustion, levels 1-6, 6 = death — rather than a
 * spendable/rechargeable pool ({@link AdapterResourceDef}, issue #422) or a plain
 * present/absent boolean (every other entry in a system's `CONDITIONS` vocabulary).
 * `ConditionInstance.stacks` (issue #1073/#1047) is the storage; this is what a client reads
 * to know WHICH condition (if any) that campaign's rule system treats this way, and its cap.
 *
 * Deliberately a standalone lookup keyed by adapter id, NOT a field on
 * `RuleSystemAdapter`'s interface or its object literals — issue #1599 (save resolution
 * through the rule-system adapter) is concurrently editing those same large object
 * literals, and this track needs no per-adapter METHOD, only a static name + cap that a
 * system either has or doesn't. A lookup table is the smaller, non-colliding surface for
 * that, matching how {@link RestModel} et al. already live in their own file rather than
 * as adapter-object fields for the pieces that are pure data.
 */
export type LeveledConditionTrack = {
  /** The condition name this tracks — matches an entry in the system's CONDITIONS vocabulary. */
  name: string;
  /** Inclusive maximum level. 5e: 6 (death). */
  max: number;
};

/**
 * Keyed by `RuleSystemAdapter.id` (the stable family id, e.g. `'dnd5e'` — NOT a rule-pack
 * slug, which multiple slugs can resolve to the same adapter through). PF2e has no entry:
 * that is deliberate for #1643 (PF2e's wounded/doomed/drained tracks are a different shape
 * and out of scope here), not an oversight — `leveledConditionTrackFor` returning
 * `undefined` for `'pf2e'` IS the negative case the issue asks for.
 */
const LEVELED_CONDITION_TRACKS: Readonly<Record<string, LeveledConditionTrack>> = {
  dnd5e: { name: 'Exhaustion', max: 6 },
};

/** The leveled condition track for a resolved adapter's id, or `undefined` for a system with none. */
export function leveledConditionTrackFor(adapterId: string): LeveledConditionTrack | undefined {
  return LEVELED_CONDITION_TRACKS[adapterId];
}
