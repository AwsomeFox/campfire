/**
 * App-wide roll-result toast host (issue #1315). `useRoller` and SharedDiceLog
 * call `showRoll` after a local roll; RunSessionPage registers an apply-damage
 * handler while an encounter is running so damage-suitable rolls get a one-tap
 * shortcut into the existing ApplyDamageBar flow.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { DiceRoll } from '@campfire/schema';
import { looksLikeDamageRoll } from '../lib/looksLikeDamageRoll';
import { RollResultToast } from './RollResultToast';
import { useUndoSnackbarChrome } from './useUndoSnackbarChrome';

/** Publish tab-bar / keyboard chrome vars while the toast is visible (issue #1315). */
function RollResultToastChrome() {
  useUndoSnackbarChrome();
  return null;
}

type ApplyDamageHandler = (amount: number, label: string) => void;

interface RollResultToastContextValue {
  showRoll: (roll: DiceRoll) => void;
  setApplyDamageHandler: (handler: ApplyDamageHandler | null) => void;
}

const noop: RollResultToastContextValue = {
  showRoll: () => {},
  setApplyDamageHandler: () => {},
};

const RollResultToastContext = createContext<RollResultToastContextValue>(noop);

export function RollResultToastProvider({ children }: { children: ReactNode }) {
  const [roll, setRoll] = useState<DiceRoll | null>(null);
  const [applyHandler, setApplyHandler] = useState<ApplyDamageHandler | null>(null);

  const showRoll = useCallback((r: DiceRoll) => {
    setRoll(r);
  }, []);

  const setApplyDamageHandler = useCallback((handler: ApplyDamageHandler | null) => {
    setApplyHandler(handler);
  }, []);

  const dismiss = useCallback(() => setRoll(null), []);

  const handleApply = useCallback(() => {
    if (!roll || !applyHandler || !looksLikeDamageRoll(roll)) return;
    const label = roll.label || roll.expr;
    applyHandler(Math.max(0, roll.total), label);
    dismiss();
  }, [roll, applyHandler, dismiss]);

  const canApply = roll != null && applyHandler != null && looksLikeDamageRoll(roll);

  return (
    <RollResultToastContext.Provider value={{ showRoll, setApplyDamageHandler }}>
      {children}
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
  useEffect(() => {
    setApplyDamageHandler(handler ?? null);
    return () => setApplyDamageHandler(null);
  }, [handler, setApplyDamageHandler]);
}
