/**
 * Renders the individual dice of a roll, striking through the ones that were dropped
 * by a keep/drop clause (issue #130) — e.g. advantage "2d20kh1" shows both d20s with
 * the lower one struck out, so the shared feed is honest about what was rolled and
 * which die actually counted.
 *
 * `kept` is the subset (from the server) that counted toward the total. When it's
 * absent every die counted (a plain roll), so nothing is struck. Which specific dice
 * are "kept" is resolved by multiset match against `rolls`, preserving position.
 */

interface RolledDiceProps {
  rolls: number[];
  kept?: number[];
  /** Font size for the dice list. */
  fontSize?: number;
}

/** Per-die kept/dropped flags, matched positionally against the kept multiset. */
function keptFlags(rolls: number[], kept?: number[]): boolean[] {
  if (!kept) return rolls.map(() => true);
  const remaining = new Map<number, number>();
  for (const v of kept) remaining.set(v, (remaining.get(v) ?? 0) + 1);
  return rolls.map((v) => {
    const left = remaining.get(v) ?? 0;
    if (left > 0) {
      remaining.set(v, left - 1);
      return true;
    }
    return false;
  });
}

export function RolledDice({ rolls, kept, fontSize = 11 }: RolledDiceProps) {
  const flags = keptFlags(rolls, kept);
  const hasDropped = flags.some((k) => !k);
  return (
    <span
      className="text-muted"
      style={{ fontSize, whiteSpace: 'nowrap' }}
      aria-label={
        hasDropped
          ? `Rolled ${rolls.join(', ')}; kept ${(kept ?? rolls).join(', ')}`
          : `Rolled ${rolls.join(', ')}`
      }
    >
      [
      {rolls.map((v, i) => (
        <span key={i}>
          {i > 0 ? ', ' : ''}
          <span
            style={
              flags[i]
                ? undefined
                : { textDecoration: 'line-through', opacity: 0.5 }
            }
          >
            {v}
          </span>
        </span>
      ))}
      ]
    </span>
  );
}
