/**
 * App-wide roll-result toast host (issue #1315) with BG-style dice overlay (issue #1352).
 * `useRoller` and SharedDiceLog call `beginRollAnimation` before POST and `showRoll`
 * after; RunSessionPage registers an apply-damage handler while an encounter is running.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DiceRoll } from '@campfire/schema';
import { looksLikeDamageRoll } from '../lib/looksLikeDamageRoll';
import { expandDiceSidesFromExpr } from '../lib/parseDiceSidesFromExpr';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { buildOverlayDice, DiceRollOverlay, DICE_ROLL_MIN_TUMBLE_MS, type DiceRollOverlayPhase } from './DiceRollOverlay';
import { RollResultToast } from './RollResultToast';
import { useUndoSnackbarChrome } from './useUndoSnackbarChrome';

import { useAuth } from '../app/auth';

/** Publish tab-bar / keyboard chrome vars while the toast is visible (issue #1315). */
function RollResultToastChrome() {
  useUndoSnackbarChrome();
  return null;
}

type ApplyDamageHandler = (amount: number, label: string, diceTotal?: number) => void;

/**
 * Dice-only contribution for a critical-hit apply. Compound roll terms retain their
 * signed `value`, so `2d6-1d4+3` doubles `2d6-1d4`, never the +3. Physical/manual
 * totals and modifier-only rolls deliberately return undefined: they cannot support an
 * honest dice-only critical.
 */
export function reliableDiceSubtotal(roll: DiceRoll): number | undefined {
  if (roll.source === 'manual' || roll.rolls.length === 0) return undefined;
  let subtotal: number;
  if (roll.terms) {
    const diceTerms = roll.terms.filter((term) => term.rolls !== undefined);
    if (diceTerms.length === 0) return undefined;
    subtotal = diceTerms.reduce((sum, term) => sum + term.value, 0);
  } else {
    // A no-terms rolled result is a single dice expression with no flat modifier.
    subtotal = roll.total;
  }
  return subtotal > 0 ? subtotal : undefined;
}

export interface ShowRollOptions {
  /** Encounter apply-damage handler captured at roll time (character-card rolls). */
  onApply?: ApplyDamageHandler;
  /** Exact per-face dice sides when the response expands beyond the submitted expression. */
  animationSides?: number[];
  /**
   * Structurally excludes this roll from the apply-damage bridge (issue #1904 review
   * finding), regardless of what `looksLikeDamageRoll`'s label/expression heuristic would
   * conclude. Needed because that heuristic has no notion of roll INTENT — it only sees a
   * positive, non-d20, non-"heal"/"cure"-labeled expression, which is exactly what a
   * non-5e initiative roll (e.g. Starforged's 1d6) looks like. Extending the heuristic with
   * an "initiative" label check would only move the same guess one word along for the next
   * non-d20 roll kind that isn't damage; this flag lets a caller that KNOWS its roll's
   * intent opt out unconditionally instead. Full roll-kind plumbing is issue #1511's
   * broader scope — this is the narrow, call-site-scoped fix this PR needs.
   */
  applyDisabled?: boolean;
}

interface OverlayState {
  sides: number[];
  phase: DiceRollOverlayPhase;
  values?: number[];
  kept?: number[];
}

interface RollResultToastContextValue {
  beginRollAnimation: (expr: string) => void;
  cancelRollAnimation: () => void;
  showRoll: (roll: DiceRoll, options?: ShowRollOptions) => void;
  setApplyDamageHandler: (handler: ApplyDamageHandler | null) => void;
}

const noop: RollResultToastContextValue = {
  beginRollAnimation: () => {},
  cancelRollAnimation: () => {},
  showRoll: () => {},
  setApplyDamageHandler: () => {},
};

const RollResultToastContext = createContext<RollResultToastContextValue>(noop);

export function RollResultToastProvider({ children }: { children: ReactNode }) {
  const [roll, setRoll] = useState<DiceRoll | null>(null);
  const [rollApplyHandler, setRollApplyHandler] = useState<ApplyDamageHandler | null>(null);
  // Issue #1904 review finding: set from ShowRollOptions.applyDisabled at showRoll time —
  // structurally overrides looksLikeDamageRoll for a roll whose caller knows it is not damage.
  const [rollApplyDisabled, setRollApplyDisabled] = useState(false);
  const applyHandlerRef = useRef<ApplyDamageHandler | null>(null);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);

  const overlayRef = useRef<OverlayState | null>(null);
  overlayRef.current = overlay;
  const tumbleStartedAtRef = useRef(0);
  const pendingShowRef = useRef<{ roll: DiceRoll; options?: ShowRollOptions } | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current != null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const beginRollAnimation = useCallback((expr: string) => {
    clearSettleTimer();
    pendingShowRef.current = null;
    if (prefersReducedMotion()) return;
    const sides = expandDiceSidesFromExpr(expr);
    if (sides.length === 0) return;
    tumbleStartedAtRef.current = Date.now();
    const next: OverlayState = { sides, phase: 'tumbling' };
    overlayRef.current = next;
    setOverlay(next);
  }, [clearSettleTimer]);

  const cancelRollAnimation = useCallback(() => {
    clearSettleTimer();
    pendingShowRef.current = null;
    overlayRef.current = null;
    setOverlay(null);
  }, [clearSettleTimer]);

  const applyToast = useCallback((r: DiceRoll, options?: ShowRollOptions) => {
    setRoll(r);
    setRollApplyHandler(options?.onApply ?? null);
    setRollApplyDisabled(options?.applyDisabled === true);
  }, []);

  const showRoll = useCallback((r: DiceRoll, options?: ShowRollOptions) => {
    if (options?.onApply) setRollApplyHandler(options.onApply);

    if (prefersReducedMotion() || !overlayRef.current) {
      applyToast(r, options);
      return;
    }

    pendingShowRef.current = { roll: r, options };
    const wait = Math.max(0, DICE_ROLL_MIN_TUMBLE_MS - (Date.now() - tumbleStartedAtRef.current));

    const goSettle = () => {
      setOverlay((prev) => {
        if (!prev || prev.phase !== 'tumbling') return prev;
        return {
          ...prev,
          sides: options?.animationSides ?? prev.sides,
          phase: 'settling',
          values: r.rolls,
          kept: r.kept,
        };
      });
    };

    clearSettleTimer();
    if (wait > 0) settleTimerRef.current = setTimeout(goSettle, wait);
    else goSettle();
  }, [applyToast, clearSettleTimer]);

  const handleOverlaySettled = useCallback(() => {
    const pending = pendingShowRef.current;
    overlayRef.current = null;
    setOverlay(null);
    pendingShowRef.current = null;
    if (pending) applyToast(pending.roll, pending.options);
  }, [applyToast]);

  const setApplyDamageHandler = useCallback((handler: ApplyDamageHandler | null) => {
    applyHandlerRef.current = handler;
  }, []);

  const dismiss = useCallback(() => {
    setRoll(null);
    setRollApplyHandler(null);
    setRollApplyDisabled(false);
  }, []);

  const activeApplyHandler = rollApplyHandler ?? applyHandlerRef.current;

  const handleApply = useCallback(() => {
    if (!roll) return;
    if (rollApplyDisabled) return;
    const handler = rollApplyHandler ?? applyHandlerRef.current;
    if (!handler) return;
    if (rollApplyHandler == null && !looksLikeDamageRoll(roll)) return;
    const label = roll.label || roll.expr;
    handler(Math.max(0, roll.total), label, reliableDiceSubtotal(roll));
    dismiss();
  }, [roll, rollApplyHandler, rollApplyDisabled, dismiss]);

  const canApply =
    !rollApplyDisabled &&
    roll != null &&
    activeApplyHandler != null &&
    (rollApplyHandler != null || looksLikeDamageRoll(roll));

  const overlayDice = overlay
    ? buildOverlayDice(overlay.sides, overlay.values, overlay.kept)
    : [];

  const { me } = useAuth();

  return (
    <RollResultToastContext.Provider
      value={{ beginRollAnimation, cancelRollAnimation, showRoll, setApplyDamageHandler }}
    >
      {children}
      {overlay && overlayDice.length > 0 && (
        <DiceRollOverlay
          dice={overlayDice}
          phase={overlay.phase}
          theme={me?.user?.diceTheme}
          onSettled={handleOverlaySettled}
        />
      )}
      {roll && (
        <>
          <RollResultToastChrome />
          <RollResultToast roll={roll} onDismiss={dismiss} onApply={canApply ? handleApply : undefined} />
        </>
      )}
    </RollResultToastContext.Provider>
  );
}

export function useRollResultToast(): RollResultToastContextValue {
  return useContext(RollResultToastContext);
}

/** Register (or clear) the encounter apply-damage handler for the toast Apply action. */
export function useRollApplyDamageBridge(handler: ApplyDamageHandler | undefined) {
  const { setApplyDamageHandler } = useRollResultToast();
  useLayoutEffect(() => {
    setApplyDamageHandler(handler ?? null);
    return () => setApplyDamageHandler(null);
  }, [handler, setApplyDamageHandler]);
}
