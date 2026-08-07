/**
 * Translated display names for adapter-declared resource/condition vocabulary
 * (issue #2053).
 *
 * `RuleSystemAdapter.resources[].name` and `.conditions[]` (`@campfire/schema`) are
 * plain English strings. `@campfire/schema` stays locale-free by design — it is the
 * shared domain contract consumed by the server, MCP, and the AI surface, none of
 * which have any use for locale data — so the translation lives here instead, keyed
 * by the adapter's stable identifier rather than the English string itself:
 *
 *  - a resource's `key` (e.g. `inspiration`, `heroPoints`) is already a stable id
 *    distinct from its display `name`, which differs per adapter for the same key
 *    (5e's `hitDice` is "Hit Dice"; PF2e's is "Hit Dice / Stamina").
 *  - a condition has no separate id in the schema — the declared English name IS
 *    the stable key (`RuleSystemAdapter.conditions: readonly string[]`).
 *
 * Either way, a homebrew or not-yet-cataloged entry falls back to the adapter's own
 * declared English name — never a raw catalog key, never a crash. The MCP/AI surface
 * (`GET :id/resource-vocabulary`, AI tools) does not use this: it stays English,
 * addressing a model rather than a human.
 *
 * `t` is typed loosely, matching `translateApiError` (`lib/api.ts`), so this stays
 * dependency-free; pass react-i18next's `t`.
 */

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string;

/**
 * Translated name for an adapter-declared resource pool (5e Inspiration, PF2e Hero
 * Points, Hit Dice, …). Pass the resource's own `key` and declared `name` — from an
 * `AdapterResourceDef`, or a character's own stored resource record, whose map key
 * is the same stable identifier.
 */
export function adapterResourceLabel(t: TranslateFn, def: { key: string; name: string }): string {
  return t(`encounters.adapterResource.${def.key}`, { defaultValue: def.name });
}

/**
 * Translated name for an adapter-declared condition — the system's `CONDITIONS`
 * vocabulary (Blinded, Poisoned, …) or a leveled track like 5e Exhaustion. A
 * DM-typed custom condition with no catalog entry falls back to itself unchanged.
 */
export function adapterConditionLabel(t: TranslateFn, name: string): string {
  return t(`encounters.adapterCondition.${name}`, { defaultValue: name });
}
