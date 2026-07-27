import { ConditionInstance, deriveConditionNames } from '@campfire/schema';
import { z } from 'zod';
import { fromJsonText, toJsonText } from './json';

/**
 * The one place that writes a combatant's conditions.
 *
 * A combatant stores its conditions TWICE: the legacy `conditions` string array, and the
 * structured `conditionInstances` blob added by #423 which carries duration, source,
 * concentration and repeat-save metadata. They must never disagree — `conditions` is
 * supposed to be exactly `deriveConditionNames(conditionInstances)`.
 *
 * That invariant used to be enforced per call site, and five of the seven writers set only
 * `conditions`: `action-resolver.service.ts` on both apply AND undo, and the sheet→combatant
 * mirror in `characters.service.ts`. Because the read path unions (it adds legacy names that
 * have no instance, but never drops instances that have no legacy name), a REMOVAL survived
 * in the structured copy and the next write that touched conditions re-derived it back into
 * visibility — a DM removed a condition and watched it return. See
 * test/integration/encounter-condition-sync.spec.ts.
 *
 * So the fix is not five corrected copies: that shape re-breaks the moment a sixth writer is
 * added. Both helpers below return BOTH columns, and no writer should set either field
 * directly. If you find yourself typing `conditions:` or `conditionInstances:` into a
 * drizzle `.set()`, use one of these instead.
 *
 * There are two legitimate directions:
 *
 *   - INSTANCE-AUTHORITATIVE — the caller has already computed the instances (the turn tick,
 *     `updateCombatant`'s structured deltas). Names are derived from them.
 *   - NAME-AUTHORITATIVE — the caller only has strings (a resolved action, an undo snapshot,
 *     a character sheet). Instances are reconciled against those names: metadata is preserved
 *     for names that survive, instances for names that are gone are DROPPED, and names with
 *     no instance get a bare legacy one.
 */

/** A metadata-free instance for a condition that only ever existed as a string. */
export function legacyConditionInstance(rawName: string): ConditionInstance | null {
  const name = rawName.trim();
  if (!name) return null;
  // Bound the generated id to the schema max(40) and keep it stable.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 33);
  return {
    id: `legacy_${slug || 'condition'}`.slice(0, 40),
    name,
    ruleEntryId: null,
    source: null,
    sourceCombatantId: null,
    durationRounds: null,
    roundsRemaining: null,
    timing: 'none',
    saveTiming: 'none',
    saveDc: null,
    saveAbility: null,
    isConcentration: false,
    stacks: 1,
    notes: '',
    custom: false,
  };
}

/** Parse the stored blob; corrupt/legacy text degrades to an empty list. */
export function parseConditionInstancesText(text: string | null): ConditionInstance[] {
  if (text == null) return [];
  const parsed = z.array(ConditionInstance).safeParse(fromJsonText<unknown>(text, null));
  return parsed.success ? parsed.data : [];
}

/**
 * Reconcile structured instances against an authoritative list of names.
 *
 * Unlike a union, this DROPS instances whose name is absent from `names` — that is the whole
 * point, and the reason a removal now sticks. Matching is case-insensitive on the trimmed
 * name, mirroring how the read path deduplicated.
 */
export function reconcileConditionInstances(
  names: readonly string[],
  prior: readonly ConditionInstance[],
): ConditionInstance[] {
  const wanted = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name) wanted.set(name.toLowerCase(), name);
  }
  const out: ConditionInstance[] = [];
  const seen = new Set<string>();
  // Keep surviving instances in their existing order, preserving their metadata.
  for (const inst of prior) {
    const key = inst.name.trim().toLowerCase();
    if (!wanted.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(inst);
  }
  // Names with no instance yet get a bare one so the two columns agree.
  for (const [key, name] of wanted) {
    if (seen.has(key)) continue;
    const legacy = legacyConditionInstance(name);
    if (legacy) {
      seen.add(key);
      out.push(legacy);
    }
  }
  return out.slice(0, 50);
}

/** Both condition columns, for a writer that knows the names but not the metadata. */
export function conditionWriteSetFromNames(
  names: readonly string[],
  priorInstancesText: string | null,
): { conditions: string; conditionInstances: string } {
  const instances = reconcileConditionInstances(names, parseConditionInstancesText(priorInstancesText));
  return { conditions: toJsonText(deriveConditionNames(instances)), conditionInstances: toJsonText(instances) };
}

/** Both condition columns, for a writer that has already computed the instances. */
export function conditionWriteSetFromInstances(
  instances: readonly ConditionInstance[],
): { conditions: string; conditionInstances: string } {
  const bounded = instances.slice(0, 50);
  return { conditions: toJsonText(deriveConditionNames(bounded)), conditionInstances: toJsonText(bounded) };
}
