/**
 * The tabletop-sane bounds the dice roller enforces, and a pure predicate for "will the
 * roller actually accept this?" (issue #2097 review, chatgpt-codex-connector P2).
 *
 * `DiceExprPattern` (index.ts) describes the SHAPE of a dice expression; it does not bound
 * the numbers. The authoritative roller in `apps/server/src/common/dice.ts` additionally
 * rejects a count outside 1..20, a non-polyhedral side count, and an oversized modifier —
 * so `21d6` and `1d3` both match the pattern and both throw when rolled.
 *
 * That gap mattered because anything building an `ActionSpec` has promised something: a spec
 * marked resolvable will be rolled mid-combat. A spec built on `21d6` degrades not to a
 * text-only action but to an error at the table, which is the one outcome the derivation's
 * "no silent fallback math" rule exists to prevent. Producers therefore need the roller's
 * real answer BEFORE building a spec, and this is the single place that answer lives.
 *
 * A leaf module with no imports: `apps/server/src/common/dice.ts` consumes these constants as
 * its enforcement bounds, and `equipped-item-action.ts` consumes the predicate — neither can
 * drift from the other, and neither creates an import cycle with index.ts.
 */

/** Standard polyhedral faces. A d3 or d7 is not rollable, however plausible it looks. */
export const DICE_ALLOWED_SIDES: ReadonlySet<number> = new Set([2, 4, 6, 8, 10, 12, 20, 100]);
/** Maximum dice in one term. */
export const DICE_MAX_COUNT = 20;
/** Maximum absolute value of a flat modifier. */
export const DICE_MAX_MODIFIER_ABS = 999;

/**
 * One `NdM` term with an optional `+K`/`-K` modifier — the shape a damage formula takes.
 *
 * Digit limits mirror `DiceExprPattern` exactly (index.ts): count 1-2 digits, sides 1-3,
 * modifier 1-3. Review (chatgpt-codex-connector P2): bounding only the parsed NUMBERS let
 * `001d6` through — its count is 1, but the roller's own grammar rejects three count digits,
 * so it produced a resolvable spec that threw at roll time. Checking the grammar AND the
 * bounds is what makes "rollable" mean rollable.
 */
const SIMPLE_DAMAGE_EXPRESSION = /^(\d{1,2})d(\d{1,3})(?:\s*([+-])\s*(\d{1,3}))?$/i;

/**
 * Whether `expr` is a single die term (plus optional flat modifier) the roller will accept.
 *
 * Deliberately narrower than the full compound grammar `DiceExprPattern` allows: this answers
 * the damage-formula question ("1d8", "2d6+3"), which is what action specs carry. A compound
 * expression returns false rather than a maybe — a producer that cannot prove an expression
 * rollable should fall back to text, not guess.
 */
export function isRollableDamageExpression(expr: string): boolean {
  const match = expr.trim().replace(/\s+/g, '').match(SIMPLE_DAMAGE_EXPRESSION);
  if (!match) return false;
  const count = Number(match[1]);
  const sides = Number(match[2]);
  if (!Number.isInteger(count) || count < 1 || count > DICE_MAX_COUNT) return false;
  if (!DICE_ALLOWED_SIDES.has(sides)) return false;
  if (match[4] !== undefined && Math.abs(Number(match[4])) > DICE_MAX_MODIFIER_ABS) return false;
  return true;
}
