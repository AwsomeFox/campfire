/**
 * Per-term breakdown of a compound dice roll (issue #536). Renders alongside the flat
 * dice list when the server returns `terms` — e.g. for "1d20+1d4+3" it shows
 * "1d20: 14, 1d4: 2, +3" — so a magic weapon's multi-die roll reads term-by-term instead
 * of as one opaque flattened list. Absent for a classic single-term roll (no `terms`),
 * so nothing renders there and the existing `RolledDice` flat list stands on its own.
 *
 * A die term shows its face value(s) (kept subset struck through when a keep/drop clause
 * applied to that term); a modifier term shows its signed value. Values are dimmed so the
 * total remains the visual focal point, matching RolledDice's muted treatment.
 */
import type { RollResultTerm } from '@campfire/schema';

interface RolledTermsProps {
  terms: RollResultTerm[];
  /** Font size for the breakdown line. */
  fontSize?: number;
}

/** Per-die kept/dropped flags for a single term, matched positionally via multiset. */
function termKeptFlags(rolls: number[], kept?: number[]): boolean[] {
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

export function RolledTerms({ terms, fontSize = 11 }: RolledTermsProps) {
  return (
    <span className="text-muted" style={{ fontSize, whiteSpace: 'nowrap' }} aria-label="roll breakdown">
      {terms.map((t, i) => {
        const sep = i === 0 ? '' : ', ';
        if (t.rolls && t.rolls.length > 0) {
          const flags = termKeptFlags(t.rolls, t.kept);
          const dice = t.rolls.map((v, idx) => (
            <span
              key={idx}
              style={flags[idx] ? undefined : { textDecoration: 'line-through', opacity: 0.5 }}
            >
              {v}
            </span>
          ));
          return (
            <span key={i}>
              {sep}
              {t.term}: {dice}
            </span>
          );
        }
        // Modifier term: render its signed value ("+3" / "-2").
        return (
          <span key={i}>
            {sep}
            {t.term}
          </span>
        );
      })}
    </span>
  );
}
