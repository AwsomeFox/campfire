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

type ApplyDamageHandler = (amount: number, label: string) => void;

export interface ShowRollOptions {
  /** Encounter apply-damage handler captured at roll time (character-card rolls). */
  onApply?: ApplyDamageHandler;
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
  }, []);

  const activeApplyHandler = rollApplyHandler ?? applyHandlerRef.current;

  const handleApply = useCallback(() => {
    if (!roll) return;
    const handler = rollApplyHandler ?? applyHandlerRef.current;
    if (!handler) return;
    if (rollApplyHandler == null && !looksLikeDamageRoll(roll)) return;
    const label = roll.label || roll.expr;
    handler(Math.max(0, roll.total), label);
    dismiss();
  }, [roll, rollApplyHandler, dismiss]);

  const canApply =
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
