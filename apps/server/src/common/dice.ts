import { randomInt } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { DiceExprPattern, type RollResult } from '@campfire/schema';

/**
 * Tiny, SAFE dice expression parser/roller — no eval(), no dynamic Function().
 * Matches @campfire/schema's RollRequest.expr pattern (DiceExprPattern) so anything
 * that passes zod validation is guaranteed to parse here too.
 *
 * Supports COMPOUND expressions (issue #536): a sum of terms joined by + / -, where each
 * term is either a die ("NdM", optionally with a keep/drop clause) or a bare integer
 * modifier. Examples: "1d20+3", "2d6-1", "d20" (== "1d20"), "2d20kh1" (advantage),
 * "4d6dl1+2" (stat-gen), and now "1d20+1d4+3", "2d6-1d4-2", "+5", "-1d4".
 *
 * Beyond the regex shape, we further constrain to tabletop-sane bounds:
 *  - count (N): 1..20, defaults to 1 when omitted
 *  - sides (M): one of the standard polyhedral die faces {2,4,6,8,10,12,20,100}
 *  - modifier (K): |K| <= 999
 * Anything outside these bounds is a 400, even if it matched the regex.
 *
 * Optional keep/drop clause (issue #130) sits between the die and the modifier:
 *  - khN: keep the highest N dice   (advantage: "2d20kh1")
 *  - klN: keep the lowest N dice    (disadvantage: "2d20kl1")
 *  - dhN: drop the highest N dice
 *  - dlN: drop the lowest N dice    (stat-gen: "4d6dl1")
 * Keep N must be 1..count; drop N must be 1..count-1 (at least one die survives).
 */
const ALLOWED_SIDES = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
const MAX_COUNT = 20;
const MAX_MODIFIER_ABS = 999;

export type KeepMode = 'kh' | 'kl' | 'dh' | 'dl';

export interface KeepSpec {
  mode: KeepMode;
  n: number;
}

/** A single die term: NdM with an optional keep/drop clause. No modifier — modifiers
 *  are their own term kind in a compound expression. */
export interface ParsedDieTerm {
  kind: 'die';
  count: number;
  sides: number;
  /** Present only when the term carried a khN/klN/dhN/dlN clause. */
  keep?: KeepSpec;
  /** The term's leading sign — '-' for a subtracted die (e.g. "-1d4" in "2d6-1d4"),
   *  '+' otherwise. Defaults to '+' so a classic leading die ("2d6") adds as expected. */
  sign?: '+' | '-';
}

/** A bare integer modifier term: +K or -K. */
export interface ParsedModifierTerm {
  kind: 'modifier';
  /** Signed value (carries the leading +/-). */
  value: number;
}

/** Any single term of a compound dice expression. */
export type DiceTerm = ParsedDieTerm | ParsedModifierTerm;

export interface ParsedDiceExpr {
  count: number;
  sides: number;
  modifier: number;
  /** Present only when the expression carried a khN/klN/dhN/dlN clause. */
  keep?: KeepSpec;
}

/**
 * Backward-compatible single-term view (issue #79). Equivalent to parsing a classic
 * "NdM+K" expression: the (single) die term's count/sides/keep plus the modifier folded
 * in from the (optional) modifier term. Throws if the expression is compound (more than
 * one die term) — callers that previously assumed a single die should migrate to
 * parseCompoundDiceExpr. In practice every legacy caller feeds a classic single-die
 * expression, so this preserves their exact prior behavior.
 */
export function parseDiceExpr(expr: string): ParsedDiceExpr {
  const terms = parseCompoundDiceExpr(expr);
  const dieTerms = terms.filter((t): t is ParsedDieTerm => t.kind === 'die');
  // The classic single-die view can only represent ONE positive die plus a folded modifier.
  // A leading-minus die ("-1d4") or more than one die term is a compound-only shape — its
  // callers should use parseCompoundDiceExpr / rollDice, which model signed terms.
  if (dieTerms.length !== 1 || dieTerms[0].sign === '-') {
    throw new BadRequestException(
      `Invalid dice expression "${expr}" — expected NdM+K, e.g. "1d20+3" or "2d20kh1"`,
    );
  }
  const die = dieTerms[0];
  const modifier = terms
    .filter((t): t is ParsedModifierTerm => t.kind === 'modifier')
    .reduce((sum, m) => sum + m.value, 0);
  return { count: die.count, sides: die.sides, modifier, keep: die.keep };
}

/** One die term without the leading sign: "NdM", optionally "(kh|kl|dh|dl)N". */
const DIE_TERM_PATTERN = /^(\d{1,2})?d(\d{1,3})\s*((?:kh|kl|dh|dl)\s*\d{1,2})?$/i;

function parseKeepClause(raw: string, count: number): KeepSpec {
  const km = /^(kh|kl|dh|dl)\s*(\d{1,2})$/i.exec(raw.replace(/\s+/g, ''));
  // The outer regex already guarantees the shape, so km is non-null; guard anyway.
  if (!km) {
    throw new BadRequestException(`Invalid keep/drop clause "${raw.trim()}"`);
  }
  const mode = km[1].toLowerCase() as KeepMode;
  const n = parseInt(km[2], 10);
  if (mode === 'kh' || mode === 'kl') {
    if (n < 1 || n > count) {
      throw new BadRequestException(`Keep count must be between 1 and the number of dice (${count})`);
    }
  } else {
    // dh/dl: must leave at least one die behind.
    if (n < 1 || n >= count) {
      throw new BadRequestException(`Drop count must be between 1 and ${count - 1} (need more than one die to drop)`);
    }
  }
  return { mode, n };
}

/**
 * Parses a compound dice expression into signed terms (issue #536). The expression is a
 * sum of die terms ("NdM", with an optional keep/drop clause) and bare integer modifiers,
 * joined by + / -. A leading sign is allowed (e.g. "-1d4", "+5"). The DiceExprPattern
 * regex already guaranteed the overall shape, so this tokenizer only needs to split on
 * the signed boundaries and validate each term's bounds.
 */
export function parseCompoundDiceExpr(expr: string): DiceTerm[] {
  if (!DiceExprPattern.test(expr)) {
    throw new BadRequestException(
      `Invalid dice expression "${expr}" — expected a sum of die terms (NdM) and modifiers, e.g. "1d20+3" or "1d20+1d4+3"`,
    );
  }
  // Walk the (sign, body) pairs implied by the leading-sign-normalized expression. Shared
  // with termSourceTexts so the parsed terms and the display texts stay aligned by index.
  const result = walkSignedTerms(expr, (sign, body) => parseOneTerm(sign, body));
  if (result.length === 0) {
    throw new BadRequestException(`Invalid dice expression "${expr}" — empty after parsing`);
  }
  return result;
}

/**
 * Splits the (trimmed, leading-sign-normalized) expression into (sign, body) pairs and
 * maps each via `fn`. A leading sign is synthesized as "+" when the first term is an
 * unsigned die ("1d20+..." -> "+1d20+..."). Whitespace inside bodies is preserved so the
 * per-term die/keep parsers can collapse it consistently. Used by both the parser and the
 * source-text renderer so the two stay index-aligned.
 */
function walkSignedTerms<T>(expr: string, fn: (sign: '+' | '-', body: string) => T): T[] {
  const trimmed = expr.trim();
  const signed = /^[+-]/.test(trimmed) ? trimmed : `+${trimmed}`;
  const out: T[] = [];
  let bodyStart = 1; // skip the leading sign char; body begins after it
  for (let i = 1; i < signed.length; i++) {
    const ch = signed[i];
    // Every top-level + / - is a term separator (the regex already rejected anything with
    // nesting or a trailing dangling sign), so we split on each occurrence verbatim.
    if (ch !== '+' && ch !== '-') continue;
    const body = signed.slice(bodyStart, i).trim();
    if (body) out.push(fn(asSign(signed[bodyStart - 1]), body));
    bodyStart = i + 1;
  }
  const body = signed.slice(bodyStart).trim();
  if (body) out.push(fn(asSign(signed[bodyStart - 1]), body));
  return out;
}

/** Narrows a sign char to its literal type ('+' or '-'); the regex guarantees the shape. */
function asSign(ch: string): '+' | '-' {
  return ch === '-' ? '-' : '+';
}

/** Parses one [sign]body fragment into a signed die or modifier term. */
function parseOneTerm(sign: '+' | '-', body: string): DiceTerm {
  const dieMatch = DIE_TERM_PATTERN.exec(body);
  if (dieMatch) {
    const count = dieMatch[1] ? parseInt(dieMatch[1], 10) : 1;
    const sides = parseInt(dieMatch[2], 10);
    const keepClause = dieMatch[3];
    if (count < 1 || count > MAX_COUNT) {
      throw new BadRequestException(`Dice count must be between 1 and ${MAX_COUNT}`);
    }
    if (!ALLOWED_SIDES.has(sides)) {
      throw new BadRequestException(`Die sides must be one of ${[...ALLOWED_SIDES].join(', ')}`);
    }
    const keep = keepClause ? parseKeepClause(keepClause, count) : undefined;
    // Only stamp the sign when it's '-'; '+' is the default and we want the classic
    // leading-die shape ({count,sides,keep}) to remain identical for backward compat.
    return sign === '-' ? { kind: 'die', count, sides, keep, sign: '-' } : { kind: 'die', count, sides, keep };
  }
  // Not a die -> must be a bare integer modifier (shape already guaranteed by the regex).
  const value = (sign === '-' ? -1 : 1) * parseInt(body.replace(/\s+/g, ''), 10);
  if (Math.abs(value) > MAX_MODIFIER_ABS) {
    throw new BadRequestException(`Modifier must be between -${MAX_MODIFIER_ABS} and ${MAX_MODIFIER_ABS}`);
  }
  return { kind: 'modifier', value };
}

/**
 * Given the rolled dice and a keep/drop spec, returns the indices (into `rolls`) that
 * are KEPT — i.e. count toward the total. Ties are broken by original position so the
 * choice is deterministic and the dropped dice are unambiguous for display.
 */
function keptIndices(rolls: number[], keep: KeepSpec): number[] {
  // Order indices by value; ties keep original (ascending) order.
  const byValueAsc = rolls.map((_, i) => i).sort((a, b) => rolls[a] - rolls[b] || a - b);
  let picked: number[];
  switch (keep.mode) {
    case 'kh':
      picked = byValueAsc.slice(byValueAsc.length - keep.n);
      break;
    case 'kl':
      picked = byValueAsc.slice(0, keep.n);
      break;
    case 'dl':
      picked = byValueAsc.slice(keep.n);
      break;
    case 'dh':
    default:
      picked = byValueAsc.slice(0, byValueAsc.length - keep.n);
      break;
  }
  // Return in original roll order so `kept` lines up visually with `rolls`.
  return picked.sort((a, b) => a - b);
}

function rollOne(sides: number): number {
  // randomInt's max is exclusive -> [1, sides]
  return randomInt(1, sides + 1);
}

/** Per-term breakdown entry surfaced to the UI (issue #536), matching RollResult.terms. */
export interface RollTermBreakdown {
  /** The original term text, e.g. "1d20", "1d4", "+3", "-2". */
  term: string;
  /** Net contribution of this term to the total (kept-dice sum, or the signed modifier). */
  value: number;
  /** Die terms only: every die rolled for this term, in roll order. */
  rolls?: number[];
  /** Die terms only: the kept subset (present when this term had a keep/drop clause). */
  kept?: number[];
}

/**
 * Rolls a dice expression using crypto.randomInt (uniform, no modulo bias) — fairness
 * matters for a shared multiplayer combat tracker where a DM/players roll dice everyone
 * can see, unlike a purely cosmetic client-side roller.
 *
 * Compound expressions (issue #536): each die term is rolled independently (rolling ALL
 * of its dice first, then applying its own keep/drop — never re-roll or discard eagerly,
 * so the full set is recorded and the kept subset is attestable against it). The flat
 * `rolls` array is the concatenation of every term's dice in expression order; `total`
 * is the signed sum across all terms. `terms` carries the per-term breakdown and is only
 * present for a genuinely compound expression (2+ terms), so single-term rolls keep the
 * exact legacy shape (no `terms` key).
 */
export function rollDice(expr: string): RollResult {
  const terms = parseCompoundDiceExpr(expr);
  const isCompound = terms.length > 1;

  const allRolls: number[] = [];
  const allKept: number[] = [];
  let anyKeep = false;
  let total = 0;
  const breakdown: RollTermBreakdown[] = [];

  // Re-derive each term's source text for the breakdown by re-tokenizing with offsets, so
  // the displayed term matches what the user typed (preserving their casing/whitespace
  // style as much as possible). We reuse the same sign-prefix normalization.
  const termTexts = termSourceTexts(expr);

  for (let i = 0; i < terms.length; i++) {
    const t = terms[i];
    const termText = termTexts[i];
    if (t.kind === 'modifier') {
      total += t.value;
      breakdown.push({ term: termText, value: t.value });
      continue;
    }
    // A leading-minus die ("-1d4" in "2d6-1d4") contributes negatively; the dice are still
    // rolled and recorded as positive face values — only their contribution to the total
    // (and the breakdown value) is negated. rollOne is always positive.
    const mul = t.sign === '-' ? -1 : 1;
    // Roll ALL dice first, then keep/drop — full set is recorded and attestable.
    const rolls = Array.from({ length: t.count }, () => rollOne(t.sides));
    allRolls.push(...rolls);
    if (!t.keep) {
      const sum = mul * rolls.reduce((s, r) => s + r, 0);
      total += sum;
      breakdown.push({ term: termText, value: sum, rolls });
      continue;
    }
    anyKeep = true;
    const kept = keptIndices(rolls, t.keep).map((idx) => rolls[idx]);
    allKept.push(...kept);
    const sum = mul * kept.reduce((s, r) => s + r, 0);
    total += sum;
    breakdown.push({ term: termText, value: sum, rolls, kept });
  }

  const result: RollResult = { expr, rolls: allRolls, total };
  // kept: the subset of `rolls` that counted. RolledDice resolves kept by positional
  // multiset match against `rolls`, which is only unambiguous when ALL kept dice come
  // from a single die term (a dropped die in one term could otherwise match a kept die in
  // another). So emit the flat kept ONLY when there's exactly one die term — the legacy
  // advantage/disadvantage/stat-gen shapes, including "2d20kh1+5" (one die + a modifier).
  // When 2+ die terms carry keep clauses, omit the flat kept and let `terms[].kept` be
  // the per-term source of truth (each entry's kept is unambiguous within its own rolls).
  const dieTermCount = terms.filter((t) => t.kind === 'die').length;
  if (anyKeep && dieTermCount === 1) result.kept = allKept;
  if (isCompound) result.terms = breakdown;
  return result;
}

/**
 * Splits the original expression into per-term source strings, aligned with
 * parseCompoundDiceExpr's term order (both route through walkSignedTerms). Returns the
 * display text for each term: a die body compacted of whitespace, a modifier prefixed
 * with its sign — e.g. "1d20", "1d4", "+3", "-2".
 */
function termSourceTexts(expr: string): string[] {
  return walkSignedTerms(expr, (sign, body) => termText(sign, body));
}

/** Renders a term's display text: a die body verbatim (sign kept if negative), a modifier
 *  with its sign prefix so the breakdown reads naturally ("+3" / "-2"). */
function termText(sign: '+' | '-', body: string): string {
  if (DIE_TERM_PATTERN.test(body)) {
    // Die term: strip internal whitespace so "1d20" (not "1d20 ") is shown, but keep the
    // count/sides/keep clause the user wrote (e.g. "2d20kh1"). A leading-sign die like
    // "-1d4" keeps its sign so the breakdown reads unambiguously.
    const compact = body.replace(/\s+/g, '');
    return sign === '-' ? `-${compact}` : compact;
  }
  // Modifier: render with its sign so "+3" / "-2" read naturally in the breakdown.
  const digits = body.replace(/\s+/g, '');
  return `${sign}${digits}`;
}

/**
 * Convenience: roll a plain "dN + mod" initiative check for a given initiative modifier.
 * The die defaults to 20 (D&D 5e). The d20 assumption is NOT baked in here — callers pass
 * the die from the campaign's RuleSystemAdapter (`adapter.initiativeDie`, issue #70); this
 * roller stays rule-system-agnostic, and every existing 5e caller gets the same d20 roll.
 */
export function rollInitiative(initMod: number, die = 20): number {
  return rollOne(die) + initMod;
}
