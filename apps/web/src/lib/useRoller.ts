/**
 * Shared "roll to the campaign feed" hook (issue #258, extended for the encounter
 * character card).
 *
 * Posts a roll to the exact endpoint the Dice tray / dashboard Dice card use
 * (POST /campaigns/:id/roll — see SharedDiceLog.submitExpr), so a save/skill/attack
 * rolled from the character sheet OR from the in-encounter character card lands in
 * the same shared feed everyone at the table watches. There is no per-character roll
 * field on the API, so the character name rides in the label ("Aldra · Athletics
 * check") to attribute the roll; the user identity is still recorded server-side.
 */
import { useCallback, useState } from 'react';
import type { DiceRoll } from '@campfire/schema';
import { api, API, ApiError } from './api';
import { useAnnounce } from '../components/Announcer';

export interface Roller {
  /** POST the expression to the shared dice log with a character-attributed label. */
  roll: (expr: string, label: string) => Promise<DiceRoll | null>;
  rolling: boolean;
}

/**
 * Crit/fumble flavour for a d20 roll. Matches `d20` even when preceded by a die
 * count (`1d20+3`, `2d20kh1`) — a `\bd20\b` boundary fails there because a digit is
 * a word char — while excluding `d200` via the negative lookahead. Checks the KEPT
 * die when a keep/drop clause is present (advantage/disadvantage), so a nat-20/nat-1
 * reflects the die that actually counted, not any rolled die.
 */
export function d20Flavor(r: DiceRoll): 'crit' | 'fumble' | null {
  if (!/d20(?!\d)/i.test(r.expr)) return null;
  const dice = r.kept && r.kept.length > 0 ? r.kept : r.rolls;
  if (dice.includes(20)) return 'crit';
  if (dice.includes(1)) return 'fumble';
  return null;
}

export function useRoller(campaignId: number, onError: (msg: string | null) => void): Roller & {
  last: DiceRoll | null;
  dismiss: () => void;
} {
  const [rolling, setRolling] = useState(false);
  const [last, setLast] = useState<DiceRoll | null>(null);
  const announce = useAnnounce();

  const roll = useCallback(
    async (expr: string, label: string): Promise<DiceRoll | null> => {
      setRolling(true);
      onError(null);
      try {
        const result = await api.post<DiceRoll>(`${API}/campaigns/${campaignId}/roll`, { expr, label });
        setLast(result);
        const flavor = d20Flavor(result);
        announce(
          `${result.label ? `${result.label}: ` : ''}rolled ${result.expr}, total ${result.total}` +
            (flavor === 'crit' ? ' — natural 20!' : flavor === 'fumble' ? ' — natural 1.' : ''),
        );
        return result;
      } catch (err) {
        onError(err instanceof ApiError ? err.message : "Couldn't roll the dice.");
        return null;
      } finally {
        setRolling(false);
      }
    },
    [campaignId, onError, announce],
  );

  return { roll, rolling, last, dismiss: () => setLast(null) };
}
