/**
 * Compendium/rule-pack helpers. The domain types themselves (RulePack,
 * RuleEntry, RuleEntryType, RulePackInstall) live in @campfire/schema —
 * import those directly. This file only holds the Open5e section list, which
 * isn't exported as a runtime constant from the schema package.
 */
export const RULE_SECTIONS = ['spells', 'monsters', 'items', 'conditions', 'classes', 'races', 'feats'] as const;
export type RuleSection = (typeof RULE_SECTIONS)[number];
