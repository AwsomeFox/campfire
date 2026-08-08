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
 *    distinct from its display `name` — but that id is NOT unique across adapters.
 *    5e and PF2e both declare `key: 'hitDice'` with DIFFERENT names ("Hit Dice" vs.
 *    "Hit Dice / Stamina"), and a DM/AI-customized stored resource can supply its
 *    own `name` under a `key` that happens to collide with a catalog entry too
 *    (issue #2068). Keying the catalog lookup by `key` alone silently replaces
 *    whichever of those declared/stored names doesn't match the one catalog entry.
 *    So `adapterResourceLabel` only APPLIES a catalog hit when the caller has no
 *    explicit declared name (i.e. `name` is absent or equal to `key`), or when the
 *    adapter's own declared `name` matches the catalog's ENGLISH value for that
 *    key — i.e. the catalog entry is genuinely about this same resource, not a
 *    same-keyed different one. When an explicit `name` does not match (a different
 *    adapter's resource, or a homebrew/customized name), it keeps the declared
 *    `name` verbatim rather than translating it: degrading to "correct but
 *    untranslated" is the honest failure mode here, the alternative ("translated
 *    but wrong") is not.
 *  - a condition has no separate id in the schema — the declared English name IS
 *    the stable key (`RuleSystemAdapter.conditions: readonly string[]`), so this
 *    collision shape cannot arise on the condition side: there is no second field
 *    that could diverge out from under the key. (Verified for #2068: swept every
 *    adapter's `conditions` array — `CONDITIONS`, `PF2E_CONDITIONS`,
 *    `OPEN_LEGEND_BANES_BOONS` — and confirmed no adapter attaches a different
 *    display string to a condition name another adapter also uses; SF2e shares
 *    PF2e's array by reference. `adapterConditionLabel` stays a plain key lookup.)
 *
 * Either way, a homebrew or not-yet-cataloged entry falls back to the adapter's own
 * declared English name — never a raw catalog key, never a crash. The MCP/AI surface
 * (`GET :id/resource-vocabulary`, AI tools) does not use this: it stays English,
 * addressing a model rather than a human.
 *
 * `t` is typed loosely, matching `translateApiError` (`lib/api.ts`), so this stays
 * dependency-free; pass react-i18next's `t`.
 */

type TranslateFn = (key: string, options?: { lng?: string; defaultValue?: string }) => string;

/**
 * Translated name for an adapter-declared resource pool (5e Inspiration, PF2e Hero
 * Points, Hit Dice, …). Pass the resource's own `key` and declared `name` — from an
 * `AdapterResourceDef`, or a character's own stored resource record, whose map key
 * is the same stable identifier.
 *
 * The catalog is trusted when no explicit custom display name is set (i.e. `name` is
 * absent or identical to `key`), or when it agrees with the caller's own declared
 * `name` in English (see the file doc comment for why `key` alone is not enough for
 * differing names) — so a same-keyed resource from a different adapter, or a
 * customized stored name, is never overwritten by an unrelated catalog entry.
 */
export function adapterResourceLabel(t: TranslateFn, def: { key: string; name?: string }): string {
  const key = `encounters.adapterResource.${def.key}`;
  const name = def.name;

  if (!name || name === def.key) {
    const catalogHit = t(key, { defaultValue: '' });
    return catalogHit || name || def.key;
  }

  const english = t(key, { lng: 'en', defaultValue: '' });
  if (english && english === name) {
    const catalogHit = t(key, { defaultValue: '' });
    return catalogHit || name;
  }

  return name;
}

/**
 * Translated name for an adapter-declared condition — the system's `CONDITIONS`
 * vocabulary (Blinded, Poisoned, …) or a leveled track like 5e Exhaustion. A
 * DM-typed custom condition with no catalog entry falls back to itself unchanged.
 */
export function adapterConditionLabel(t: TranslateFn, name: string): string {
  return t(`encounters.adapterCondition.${name}`, { defaultValue: name });
}
