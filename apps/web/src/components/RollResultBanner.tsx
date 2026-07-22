/**
 * Ephemeral readout of the last click-to-roll result (issue #258). The character
 * sheet and the in-encounter character card have no dice log of their own, so this
 * gives immediate feedback (label, dice, total, crit/fumble flavour) while the roll
 * also flows to the shared feed. A natural 20 / natural 1 on a d20 gets the same
 * gold/rose flourish as the shared log.
 */
import type { DiceRoll } from '@campfire/schema';
import { RolledDice } from '../features/dice/RolledDice';
import { RolledTerms } from '../features/dice/RolledTerms';
import { d20Flavor } from '../lib/useRoller';

export function RollResultBanner({ roll, onDismiss }: { roll: DiceRoll; onDismiss: () => void }) {
  const flavor = d20Flavor(roll);
  const crit = flavor === 'crit';
  const fumble = flavor === 'fumble';
  const totalColor = crit ? 'var(--cf-crit, #fbbf24)' : fumble ? 'var(--color-danger, #f87171)' : 'var(--color-accent)';
  return (
    <div className="cf-inset flex items-center gap-3 px-3.5 py-2" role="status">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold truncate">{roll.label || roll.expr}</p>
        <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
          <span>{roll.expr}</span>
          <RolledDice rolls={roll.rolls} kept={roll.kept} fontSize={11} />
          {roll.terms && <RolledTerms terms={roll.terms} fontSize={11} />}
          {crit && <span style={{ color: totalColor }}>nat 20!</span>}
          {fumble && <span style={{ color: totalColor }}>nat 1</span>}
        </p>
      </div>
      <span className="font-heading leading-none" style={{ fontSize: 26, color: totalColor }}>
        {roll.total}
      </span>
      <button
        type="button"
        aria-label="Dismiss roll result"
        onClick={onDismiss}
        className="text-slate-500 hover:text-slate-300 shrink-0"
        style={{ background: 'transparent', border: 0, cursor: 'pointer', fontSize: 14 }}
      >
        ✕
      </button>
    </div>
  );
}
