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
import { useTranslation } from 'react-i18next';
import type { DiceRoll, CheckRollResponse } from '@campfire/schema';
import { api, API, ApiError } from './api';
import { useAnnounce } from '../components/Announcer';
import { useRollResultToast, type ShowRollOptions } from '../components/RollResultToastContext';
import { formatDiceRollAnnouncement } from '../features/dice/diceLogAccessibility';
import { rememberLocalDiceAnnouncement } from '../features/dice/localDiceAnnouncements';

/** Roll modes a catalog check can be rolled with (advantage/disadvantage only where supported). */
export type CheckRollMode = 'normal' | 'advantage' | 'disadvantage' | 'crit';

export interface Roller {
  /** POST the expression to the shared dice log with a character-attributed label. */
  roll: (expr: string, label: string, options?: ShowRollOptions) => Promise<DiceRoll | null>;
  /**
   * Issue #415: roll a CATALOG check server-side. The server resolves the authoritative
   * modifier + expression from the rule-system adapter (the client sends only a checkId +
   * mode + optional dc), so proficiency math is never invented client-side. Returns the full
   * resolved response (breakdown + persisted roll + optional degree of success).
   */
  rollCheck: (
    characterId: number,
    checkId: string,
    mode?: CheckRollMode,
    dc?: number,
    /**
     * The dice expression the SERVER will roll for this check, for the pre-flight
     * animation only. Callers holding the catalog entry should pass
     * `checkRollExpr(def, mode)`: without it the animation assumes a d20, so a system whose
     * initiative or checks use another die (Starforged, OSRIC: `die: 6`) visibly tumbled a
     * d20 and then reported a d6 result.
     */
    animationExpr?: string,
  ) => Promise<CheckRollResponse | null>;
  rolling: boolean;
}

/** Re-export for existing import sites (also used by `useRoller` announcements). */
export { d20Flavor } from './d20Flavor';

export function useRoller(campaignId: number, onError: (msg: string | null) => void): Roller & {
  last: DiceRoll | null;
  dismiss: () => void;
} {
  const [rolling, setRolling] = useState(false);
  const [last, setLast] = useState<DiceRoll | null>(null);
  const { t } = useTranslation();
  const announce = useAnnounce();
  const { beginRollAnimation, cancelRollAnimation, showRoll } = useRollResultToast();

  const roll = useCallback(
    async (expr: string, label: string, options?: ShowRollOptions): Promise<DiceRoll | null> => {
      setRolling(true);
      onError(null);
      beginRollAnimation(expr);
      try {
        const result = await api.post<DiceRoll>(`${API}/campaigns/${campaignId}/roll`, { expr, label });
        setLast(result);
        showRoll(result, options);
        rememberLocalDiceAnnouncement(campaignId, result.id);
        announce(formatDiceRollAnnouncement(result, t), {
          dedupeKey: `dice-roll:${campaignId}:1:${result.id}:${result.id}`,
        });
        return result;
      } catch (err) {
        cancelRollAnimation();
        onError(err instanceof ApiError ? err.message : "Couldn't roll the dice.");
        return null;
      } finally {
        setRolling(false);
      }
    },
    [campaignId, onError, announce, beginRollAnimation, cancelRollAnimation, showRoll, t],
  );

  const rollCheck = useCallback(
    async (
      characterId: number,
      checkId: string,
      mode: CheckRollMode = 'normal',
      dc?: number,
      animationExpr?: string,
    ): Promise<CheckRollResponse | null> => {
      setRolling(true);
      onError(null);
      // The d20 fallback is only right for callers that do not hold the catalog entry.
      beginRollAnimation(animationExpr ?? (mode === 'advantage' || mode === 'disadvantage' ? '2d20kh1' : '1d20'));
      try {
        const res = await api.post<CheckRollResponse>(`${API}/characters/${characterId}/checks/roll`, {
          checkId,
          mode,
          ...(dc != null ? { dc } : {}),
        });
        setLast(res.roll);
        showRoll(res.roll);
        rememberLocalDiceAnnouncement(campaignId, res.roll.id);
        announce(formatDiceRollAnnouncement(res.roll, t), {
          dedupeKey: `dice-roll:${campaignId}:1:${res.roll.id}:${res.roll.id}`,
        });
        return res;
      } catch (err) {
        cancelRollAnimation();
        onError(err instanceof ApiError ? err.message : "Couldn't roll the check.");
        return null;
      } finally {
        setRolling(false);
      }
    },
    [campaignId, onError, announce, beginRollAnimation, cancelRollAnimation, showRoll, t],
  );

  return { roll, rollCheck, rolling, last, dismiss: () => setLast(null) };
}
