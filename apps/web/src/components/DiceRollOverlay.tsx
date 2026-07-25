/**
 * Baldur's Gate-style dice tumbling overlay (issue #1352). Shown while a local roll
 * is in flight; settles on the server-returned faces, then hands off to RollResultToast.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const DICE_ROLL_MIN_TUMBLE_MS = 650;
export const DICE_ROLL_SETTLE_MS = 550;

export type DiceRollOverlayPhase = 'tumbling' | 'settling';

export interface DiceRollOverlayDie {
  sides: number;
  value?: number;
  kept: boolean;
}

function randomFace(sides: number): number {
  return 1 + Math.floor(Math.random() * sides);
}

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

export function buildOverlayDice(
  sides: number[],
  values?: number[],
  kept?: number[],
): DiceRollOverlayDie[] {
  const count = values?.length ?? sides.length;
  const flags = values ? keptFlags(values, kept) : sides.map(() => true);
  return Array.from({ length: count }, (_, i) => ({
    sides: sides[i] ?? sides[sides.length - 1] ?? 20,
    value: values?.[i],
    kept: flags[i] ?? true,
  }));
}

export function DiceRollOverlay({
  dice,
  phase,
  onSettled,
}: {
  dice: DiceRollOverlayDie[];
  phase: DiceRollOverlayPhase;
  onSettled: () => void;
}) {
  const { t } = useTranslation();
  const [faces, setFaces] = useState<number[]>(() => dice.map((d) => randomFace(d.sides)));

  useEffect(() => {
    if (phase !== 'tumbling') return;
    const id = window.setInterval(() => {
      setFaces(dice.map((d) => randomFace(d.sides)));
    }, 70);
    return () => window.clearInterval(id);
  }, [phase, dice]);

  useEffect(() => {
    if (phase !== 'settling') return;
    setFaces(dice.map((d) => d.value ?? 1));
    const id = window.setTimeout(onSettled, DICE_ROLL_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [phase, dice, onSettled]);

  const displayFaces = useMemo(() => {
    if (phase === 'settling') return dice.map((d) => d.value ?? 1);
    return faces;
  }, [phase, dice, faces]);

  if (dice.length === 0) return null;

  return (
    <div
      className="cf-dice-roll-overlay"
      data-testid="dice-roll-overlay"
      data-phase={phase}
      role="status"
      aria-live="polite"
      aria-label={t('dice.rollOverlayLabel', { count: dice.length })}
    >
      <div className="cf-dice-roll-overlay__stage">
        {dice.map((die, i) => (
          <div
            key={i}
            className={[
              'cf-dice-roll-overlay__die',
              `cf-dice-roll-overlay__die--d${die.sides}`,
              phase === 'settling' && !die.kept ? 'cf-dice-roll-overlay__die--dropped' : '',
            ].filter(Boolean).join(' ')}
            data-sides={die.sides}
          >
            <div
              className={[
                'cf-dice-roll-overlay__inner',
                phase === 'tumbling' ? 'cf-dice-roll-overlay__inner--tumble' : 'cf-dice-roll-overlay__inner--land',
              ].join(' ')}
            >
              <span className="cf-dice-roll-overlay__value" aria-hidden="true">
                {displayFaces[i]}
              </span>
              <span className="cf-dice-roll-overlay__type" aria-hidden="true">
                d{die.sides}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
