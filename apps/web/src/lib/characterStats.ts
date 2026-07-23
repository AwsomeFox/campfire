/**
 * Shared character stat helpers (issue: encounter character cards).
 *
 * Pure, UI-agnostic helpers for reading a Character's combat numbers — ability
 * scores/modifiers, proficiency bonus, the SRD skill→ability map, and the
 * click-to-roll dice-expression builders. Extracted from CharacterPage so the
 * character sheet AND the in-encounter character card share one source of truth
 * (a sheet roll and an encounter roll must produce identical expressions/labels).
 */
import type { Character, RuleSystemAdapter } from '@campfire/schema';

export const ABILITY_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const;
export type Ability = (typeof ABILITY_KEYS)[number];

/** SRD 5e skill list with governing abilities. */
export const SKILLS: ReadonlyArray<{ name: string; ability: Ability }> = [
  { name: 'Acrobatics', ability: 'DEX' },
  { name: 'Animal Handling', ability: 'WIS' },
  { name: 'Arcana', ability: 'INT' },
  { name: 'Athletics', ability: 'STR' },
  { name: 'Deception', ability: 'CHA' },
  { name: 'History', ability: 'INT' },
  { name: 'Insight', ability: 'WIS' },
  { name: 'Intimidation', ability: 'CHA' },
  { name: 'Investigation', ability: 'INT' },
  { name: 'Medicine', ability: 'WIS' },
  { name: 'Nature', ability: 'INT' },
  { name: 'Perception', ability: 'WIS' },
  { name: 'Performance', ability: 'CHA' },
  { name: 'Persuasion', ability: 'CHA' },
  { name: 'Religion', ability: 'INT' },
  { name: 'Sleight of Hand', ability: 'DEX' },
  { name: 'Stealth', ability: 'DEX' },
  { name: 'Survival', ability: 'WIS' },
];

export const SPELL_LEVELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** 5e proficiency bonus by level: +2 at 1-4 up to +6 at 17-20. */
export function profBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/**
 * Read an ability score tolerantly. `stats` is a free-keyed record, so a character
 * saved with lowercase keys (`{ str: 16 }` — schema-valid, and what some API/MCP
 * writers produce) would miss a canonical-uppercase lookup and read 10 (issue #48).
 * The server now folds keys to uppercase, but this guards data that reaches the
 * client by any other path. Defaults to 10 when the ability is absent.
 */
export function abilityScore(character: Character, ability: Ability): number {
  const stats = character.stats;
  return stats[ability] ?? stats[ability.toLowerCase()] ?? 10;
}

// Ability modifier comes from the active campaign's rule-system adapter (issue #234),
// not the 5e formula hardcoded here — so a future non-5e adapter's math takes effect.
// Default (5e) yields floor((score - 10) / 2), unchanged.
export function modOf(adapter: RuleSystemAdapter, character: Character, ability: Ability): number {
  return adapter.abilityModifier(abilityScore(character, ability));
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

// ---------- click-to-roll (issue #258) ----------
// The sheet already knows every number (Athletics +6, Longsword +5 / 1d8+3); these
// helpers turn those into the SAME restricted dice expressions the Dice tray posts,
// so a sheet roll lands in the shared campaign feed (POST /campaigns/:id/roll) with
// no re-typing. Advantage/disadvantage reuse the tray's 2d20kh1 / 2d20kl1 keep-die
// expressions (issue #130) — a d20 roll can be taken with advantage (shift-click) or
// disadvantage (alt/ctrl-click); damage rolls ignore the modifier keys.

export type Adv = 'flat' | 'adv' | 'dis';

/**
 * Just the modifier-key flags of a mouse/pointer event. Structural on purpose — a
 * React `MouseEvent` or a DOM `MouseEvent` both satisfy it — so this helper (and the
 * module) stays UI-framework-agnostic and reusable outside React.
 */
export interface ModKeyEvent {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** How a modifier-key click maps to advantage/disadvantage on a d20 roll. */
export function advFromEvent(e: ModKeyEvent): Adv {
  if (e.shiftKey) return 'adv';
  if (e.altKey || e.ctrlKey || e.metaKey) return 'dis';
  return 'flat';
}

/** d20 check/attack expression for a numeric modifier, honouring advantage/disadvantage. */
export function d20Expr(mod: number, adv: Adv): string {
  const tail = mod === 0 ? '' : signed(mod);
  if (adv === 'adv') return `2d20kh1${tail}`;
  if (adv === 'dis') return `2d20kl1${tail}`;
  return `1d20${tail}`;
}

/**
 * Strict to-hit parser (issue #718). A to-hit field is either:
 *   - a bare integer modifier ("+5", "5", "-1") — the only historically common form, OR
 *   - a full d20 attack expression ("1d20+5", "d20+5") — the d20 is implicit on attacks.
 * Anything else (other dice like "1d8", trailing junk, ambiguous text) is REJECTED
 * (returns null) instead of silently truncating to its first integer, which is how
 * "1d20+5" used to roll as "+1".
 *
 * Returns the canonical d20 expression honouring advantage/disadvantage, or null
 * when the field is not a clean to-hit value.
 */
export function toHitExpr(toHit: string, adv: Adv): string | null {
  const trimmed = toHit.trim();
  if (!trimmed) return null;
  // Form A: bare integer modifier ("+5", "5", "-1", "+0"). A leading sign is optional.
  // We require the WHOLE field to be this integer so "1d20+5" doesn't match here.
  if (/^[+-]?\d{1,3}$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n)) return null;
    return d20Expr(n, adv);
  }
  // Form B: an explicit d20 expression ("1d20+5", "d20+5", "1d20-1"). The die MUST be
  // a d20 (an attack bonus only attaches to the d20); a different die like "1d8+5" is a
  // damage line, not a to-hit, and we reject it rather than guess. An optional leading
  // count of "1" is allowed; larger d20 pools ("2d20") belong to advantage/disadvantage
  // and should be expressed via the click modifiers, not the to-hit field.
  const d20Match = /^(?:1\s*)?d20\s*([+-]\s*\d{1,3})?$/i.exec(trimmed);
  if (d20Match) {
    const modStr = d20Match[1] ? d20Match[1].replace(/\s+/g, '') : '';
    const n = modStr ? parseInt(modStr, 10) : 0;
    if (!Number.isFinite(n)) return null;
    return d20Expr(n, adv);
  }
  // Ambiguous or non-rollable: anything else ("1d8", "advantage?", "STR", …).
  return null;
}

/** Result of parsing a single damage component: a dice expression or flat value + a damage type. */
export interface DamageComponent {
  /** Canonical roll expression ("1d8+3", "2d6") or null for a flat non-rollable amount. */
  expr: string | null;
  /** Damage type label ("slashing", "fire"), or '' when none was written. */
  type: string;
  /** Original text of this component for display. */
  text: string;
}

/**
 * Parse a compound, typed damage string (issue #718) into its components:
 *   "1d8+3 slashing"                -> [{ expr: "1d8+3", type: "slashing" }]
 *   "2d6 fire + 1d4 cold"           -> [{ expr: "2d6", type: "fire" }, { expr: "1d4", type: "cold" }]
 *   "5 fire"                        -> [{ expr: null, type: "fire" }]  (flat, not rollable)
 *   "1d8+1d6 piercing"              -> [{ expr: "1d8+1d6", type: "piercing" }]  (compound)
 *
 * Splitting happens at " + " / " + " boundaries between dice/type groups, so a
 * modifier sign inside a die term ("1d8+3") is preserved while component separators
 * ("1d8+3 slashing + 1d6 fire") split cleanly. Each die term must use a standard
 * polyhedral face {2,4,6,8,10,12,20,100}; otherwise the component is treated as
 * non-rollable flat text (no silent truncation).
 */
export function parseDamage(damage: string): DamageComponent[] {
  const trimmed = damage.trim();
  if (!trimmed) return [];
  // Split on " + " or " - " between component groups — i.e. a sign with surrounding
  // whitespace. A tight "+3" inside "1d8+3" has no surrounding spaces, so it survives.
  const parts = trimmed.split(/\s+[+-]\s+/).map((p) => p.trim()).filter(Boolean);
  return parts.map(parseDamageComponent);
}

function parseDamageComponent(raw: string): DamageComponent {
  const text = raw.trim();
  if (!text) return { expr: null, type: '', text };

  // A die-bearing component looks like a leading dice expression followed by an
  // optional damage-type label, e.g. "1d8+3 slashing", "2d6 fire", "1d8+1d6 piercing".
  // We pull the LEADING run of die/modifier terms off the front. Splitting on tight
  // sign boundaries lets "1d8+1d6" parse as TWO die terms rather than "1d8+1" + "d6…"
  // (which a naive greedy modifier match would do).
  const leading = matchLeadingDiceRun(text);
  if (leading) {
    const rawExpr = leading.expr.replace(/\s+/g, '');
    const expr = isValidDiceExpr(rawExpr) ? rawExpr : null;
    const type = leading.rest.trim();
    return { expr, type, text };
  }
  // Flat amount with optional type: "5", "+3", "-2", "5 fire", "-1 cold".
  const flatMatch = /^([+-]?\d{1,4})\s*(.*)$/i.exec(text);
  if (flatMatch) {
    const type = (flatMatch[2] || '').trim();
    return { expr: null, type, text };
  }
  // Pure type label or junk: nothing to roll, but record the text for display.
  return { expr: null, type: text, text };
}

/**
 * If `text` starts with a run of die/modifier terms (e.g. "1d8+3", "1d8+1d6",
 * "2d6-1"), return that run plus the leftover text (the damage type). Returns null
 * when the text does not begin with a die term.
 *
 * Walks the string one term at a time: a die term is `\d{0,2}d\d{1,3}` and a
 * modifier is `\d{1,3}`, joined by tight `+`/`-` signs with optional surrounding
 * whitespace. The run stops as soon as a separator is not followed by a die or
 * bare number (i.e. the rest is a damage type or junk, not another term).
 */
function matchLeadingDiceRun(text: string): { expr: string; rest: string } | null {
  // First term must be a die (NdM) — this is what makes the component rollable.
  const first = /^(?:[+-]?\s*)?(\d{0,2})\s*d\s*(\d{1,3})/i.exec(text);
  if (!first) return null;
  let i = first[0].length;
  while (i < text.length) {
    // A term separator is a + or - optionally surrounded by whitespace.
    const sep = /^([+-])\s*/.exec(text.slice(i));
    if (!sep) break;
    const afterSep = text.slice(i + sep[0].length);
    // Next term is either a die (NdM / dM) or a bare integer modifier.
    const nextDie = /^(\d{0,2}\s*)?d\s*\d{1,3}/i.exec(afterSep);
    const nextMod = /^\d{1,3}/.exec(afterSep);
    if (nextDie) {
      i += sep[0].length + nextDie[0].length;
    } else if (nextMod) {
      i += sep[0].length + nextMod[0].length;
    } else {
      // Separator present but no die/modifier follows -> the separator was part
      // of the type label (or junk); stop the run here.
      break;
    }
  }
  return { expr: text.slice(0, i), rest: text.slice(i) };
}

/**
 * Build the rollable expression for a damage field by joining its dice-bearing
 * components with "+". Returns null when there is nothing to roll (flat damage only,
 * or empty), matching the legacy contract — but now every die component contributes
 * rather than just the first.
 *
 * Example: "1d8+3 slashing + 1d4 cold" -> "1d8+3+1d4".
 */
export function damageExpr(damage: string): string | null {
  const components = parseDamage(damage);
  const dice = components.map((c) => c.expr).filter((e): e is string => e != null);
  if (dice.length === 0) return null;
  return dice.join('+');
}

const ALLOWED_DIE_SIDES = new Set([2, 4, 6, 8, 10, 12, 20, 100]);

/**
 * Validate that a dice expression matches the server's grammar (DiceExprPattern) AND
 * uses only standard polyhedral faces. Anything failing this is rendered as
 * non-rollable text rather than being silently truncated (issue #718).
 */
export function isValidDiceExpr(expr: string): boolean {
  if (!expr) return false;
  const cleaned = expr.replace(/\s+/g, '');
  // Shape: one or more (NdM | NdMkeep | modifier) terms joined by + / -. We accept a
  // leading sign too. This mirrors DiceExprPattern in @campfire/schema closely enough
  // for client-side preview; the server does the authoritative parse.
  const term = String.raw`(?:\d{0,2})?d\d{1,3}(?:\s*(?:kh|kl|dh|dl)\s*\d{1,2})?`;
  const sign = String.raw`[+-]\s*`;
  const tail = String.raw`(?:\s*[+-]\s*(?:${term}|\d{1,3}))*`;
  const re = new RegExp(String.raw`^\s*(?:${term}|${sign}(?:${term}|\d{1,3}))${tail}\s*$`, 'i');
  if (!re.test(cleaned)) return false;
  // Every die term's face must be a standard polyhedral.
  const dieTerms = cleaned.match(/\d{0,2}d\d{1,3}/gi) || [];
  for (const dt of dieTerms) {
    const sides = parseInt(dt.split('d')[1], 10);
    if (!ALLOWED_DIE_SIDES.has(sides)) return false;
  }
  return true;
}

/**
 * Human-readable preview of what a click will roll, e.g. "Campfire will roll 1d20+5".
 * Used inline on the actions card and stat card so a sheet author can see — before
 * saving — exactly how the field is being interpreted. Returns null when the field
 * is not rollable (flat damage or unparseable), so the UI can show plain text instead.
 */
export function rollPreview(toHit: string, damage: string): { hit: string | null; dmg: string | null } {
  const hit = toHitExpr(toHit, 'flat');
  const dmg = damageExpr(damage);
  return { hit, dmg };
}
