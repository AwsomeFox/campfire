import type { DiceRoll, DiceRollKind } from '@campfire/schema';
import { PHYSICAL_ROLL_EXPR } from '@campfire/schema';
import { isManualDiceRoll, physicalRollActorName } from './physicalRollForm';

/** Primary expression/label line for a dice-log row. */
export function diceRollSummaryLine(roll: DiceRoll, physicalLabel: string): string {
  const check = roll.label ? `${roll.label}: ` : '';
  if (isManualDiceRoll(roll)) {
    const nat = roll.natural20 != null ? ` (nat ${roll.natural20})` : '';
    return `${check}${physicalLabel}${roll.dc != null ? ` vs DC ${roll.dc}` : ''}${nat}`;
  }
  return `${check}${roll.expr}${roll.dc != null ? ` vs DC ${roll.dc}` : ''}`;
}

export function diceRollDisplayActor(roll: DiceRoll): string {
  return physicalRollActorName(roll);
}

export function showRolledDice(roll: DiceRoll): boolean {
  return !isManualDiceRoll(roll) && roll.rolls.length > 0;
}

export function isPhysicalRollExpr(expr: string): boolean {
  return expr === PHYSICAL_ROLL_EXPR;
}

/**
 * Shared dice log grouping/colour by roll kind (issue #2155). One `tag-*` class per
 * kind, reusing the existing chip system (see `.tag`/`.tag-*` in nocturne.css) rather
 * than introducing new colour tokens. `undefined` (unclassified — a pre-#2155 row, or
 * a manual/physical entry this server never guesses a kind for) renders no badge at
 * all, which is the honest answer: it is not wrong, it is unknown.
 */
export function diceRollKindTagClass(kind: DiceRollKind | undefined): string | null {
  switch (kind) {
    case 'to-hit':
      return 'tag-accent';
    case 'damage':
      return 'tag-amber';
    case 'check':
      return 'tag-accent-2';
    case 'roll':
      return 'tag-neutral';
    default:
      return null;
  }
}

/** i18n key for a roll kind's short badge label; null when `diceRollKindTagClass` is null. */
export function diceRollKindLabelKey(
  kind: DiceRollKind | undefined,
): 'dice.kindToHit' | 'dice.kindDamage' | 'dice.kindCheck' | 'dice.kindRoll' | null {
  switch (kind) {
    case 'to-hit':
      return 'dice.kindToHit';
    case 'damage':
      return 'dice.kindDamage';
    case 'check':
      return 'dice.kindCheck';
    case 'roll':
      return 'dice.kindRoll';
    default:
      return null;
  }
}

/**
 * Same-kind CSS var per roll kind, for the run-accent border (issue #2183). No new
 * colour tokens — every var here already exists in nocturne.css for this same kind
 * family. `null` for `undefined` (unclassified), matching `diceRollKindTagClass`.
 *
 * PR #2195 review: this deliberately does NOT match the `-800`/`-100` shades
 * `diceRollKindTagClass`'s `.tag-accent`/`.tag-accent-2`/`.tag-neutral` badges shade
 * from (a fill+foreground-text pair, where the fill can be a dark, muted -800 because
 * light -100 text always sits on top of it for contrast). A border has no text of its
 * own to pair with — it just has to read as a line against the card's dark surface —
 * so it needs the more saturated BASE token instead, exactly how the existing
 * `.tag-outline` class already borders itself with bare `var(--color-accent)` rather
 * than `--color-accent-800`. `--color-amber` matches `.tag-amber`'s own base (that
 * badge `color-mix`es FROM the same bare `--color-amber` this uses directly).
 * `--color-neutral-500` has no bare `--color-neutral` counterpart to reuse, so it is
 * the family's own mid tone, kept off the `-800`/`-100` extremes for the same reason.
 */
export function diceRollKindAccentVar(kind: DiceRollKind | undefined): string | null {
  switch (kind) {
    case 'to-hit':
      return 'var(--color-accent)';
    case 'damage':
      return 'var(--color-amber)';
    case 'check':
      return 'var(--color-accent-2)';
    case 'roll':
      return 'var(--color-neutral-500)';
    default:
      return null;
  }
}

/**
 * Issue #2183 (follow-up to #2155/#2182): the shared dice log's literal per-kind
 * *grouping*. #2182 shipped colour only; this decides how consecutive same-kind
 * rows read as one thing.
 *
 * The log is a real-time, chronologically-ordered feed (SSE-pushed, 4-8 rows
 * visible) — its whole job is "what just happened, in order." Hard sections or a
 * kind filter would fight that: same-kind rolls that happen seconds apart (a bulk
 * initiative roll, several checks in a skill challenge) would still land together
 * on screen, but an attack's to-hit immediately followed by its damage roll — two
 * DIFFERENT kinds — would be torn apart into different regions, and a live SSE
 * insert could land mid-screen instead of always at the top. So this keeps the
 * existing chronological order and array untouched, and instead marks *runs* of
 * consecutive same-kind rows (adjacent in the already-time-ordered list) so the
 * renderer can band them with one shared accent — literal grouping, zero
 * reordering.
 *
 * `undefined` (unclassified: pre-#2155 rows, manual/physical rolls) is always
 * `'solo'`, deliberately — it never starts, extends, or is absorbed into a
 * neighbour's run, because doing so would imply a guessed kind. It keeps exactly
 * today's standalone rendering, in its normal chronological slot.
 */
export type DiceRollGroupRole = 'solo' | 'start' | 'middle' | 'end';

// Consumer-side narrowing (AGENTS.md): the only field this pure function reads is
// `kind`, so the parameter is narrowed to exactly that rather than the full
// `DiceRoll` — a caller (real or test) can satisfy it with a plain `{ kind }`
// literal and no cast, and it is checked in both directions: a literal missing
// `kind` fails here, and this function reaching for any OTHER field would fail
// to compile against its own declared parameter type.
export function diceRollGroupRole(rolls: Pick<DiceRoll, 'kind'>[], index: number): DiceRollGroupRole {
  const kind = rolls[index]?.kind;
  if (!kind) return 'solo';
  const prevSame = index > 0 && rolls[index - 1]?.kind === kind;
  const nextSame = index < rolls.length - 1 && rolls[index + 1]?.kind === kind;
  if (!prevSame && !nextSame) return 'solo';
  if (!prevSame && nextSame) return 'start';
  if (prevSame && nextSame) return 'middle';
  return 'end';
}
