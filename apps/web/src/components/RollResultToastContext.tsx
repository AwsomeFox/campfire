/**
 * App-wide roll-result toast host (issue #1315) with BG-style dice overlay (issue #1352).
 * `useRoller` and SharedDiceLog call `beginRollAnimation` before POST and `showRoll`
 * after; RunSessionPage registers an apply-damage handler while an encounter is running.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DiceRoll } from '@campfire/schema';
import { d20Flavor, type D20Flavor } from '../lib/d20Flavor';
import { keptFaceFlags } from '../lib/keptFaceFlags';
import { looksLikeDamageRoll } from '../lib/looksLikeDamageRoll';
import { expandDiceSidesFromExpr } from '../lib/parseDiceSidesFromExpr';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';
import { DICE_ROLL_REDUCED_MOTION_TUMBLE_MS, SETTLE_VIBRATION_PATTERN, tableAudioEngine, vibrateIfEnabled } from '../lib/tableAudio';
import { buildOverlayDice, DiceRollOverlay, DICE_ROLL_MIN_HOLD_MS, type DiceRollOverlayPhase } from './DiceRollOverlay';
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
  /**
   * Identity of THIS roll, used as the overlay's React key.
   *
   * Without it, rolling `1d20` again while the previous `1d20` is still in the
   * air reconciles onto the same overlay instance: the dice have the same sides,
   * so nothing the 3D roller keys on changes, and it keeps replaying the first
   * throw. The second roll's faces are then dropped (its handle has already been
   * released) and the first animation hands off — dice showing the old numbers,
   * toast reporting the new total. A per-roll key makes each roll a fresh
   * overlay: new canvas, new throw, new settle latch.
   */
  id: number;
  sides: number[];
  phase: DiceRollOverlayPhase;
  values?: number[];
  /**
   * POSITIONAL kept flags, not the roll's kept faces: a compound keep/drop roll
   * (`2d20kh1+1d4`) has no unambiguous flat `kept`, so the server omits it and
   * the truth lives in `terms[]` — see ../lib/keptFaceFlags.
   */
  keptFlags?: boolean[];
  /**
   * The app's single crit/fumble answer for this roll (../lib/d20Flavor), shared
   * with the toast, the audio cue and the announcer. The overlay must not
   * re-derive it: a side count cannot tell a pooled `2d20` from an attack.
   */
  flavor?: D20Flavor | null;
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
  const { me } = useAuth();
  const tableAudioLevel = me?.user?.tableAudio ?? 'off';

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
  const rollIdRef = useRef(0);
  const pendingShowRef = useRef<{ roll: DiceRoll; options?: ShowRollOptions } | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current != null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  // Issue #1920 — unlocks the single app-wide AudioContext on the first real user
  // gesture (pointerdown/keydown) after tableAudio is enabled. Never runs before
  // enabling, and never re-arms once already unlocked. This effect is the ONLY
  // place in the app that calls the engine's unlock method — every other call
  // site only plays cues, so the context has exactly one owner.
  useEffect(() => {
    if (tableAudioLevel === 'off' || tableAudioEngine.unlocked) return;
    const handleGesture = () => {
      tableAudioEngine.unlock();
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
    window.addEventListener('pointerdown', handleGesture, { once: true });
    window.addEventListener('keydown', handleGesture, { once: true });
    return () => {
      window.removeEventListener('pointerdown', handleGesture);
      window.removeEventListener('keydown', handleGesture);
    };
  }, [tableAudioLevel]);

  const beginRollAnimation = useCallback((expr: string) => {
    clearSettleTimer();
    pendingShowRef.current = null;
    const sides = expandDiceSidesFromExpr(expr);
    if (sides.length === 0) return;
    // Audio is independent of prefers-reduced-motion (that gates visuals only —
    // see the module doc on ../lib/tableAudio), so this fires before the
    // reduced-motion early-return below. The clatter WINDOW, however, is not
    // independent of it: the default window is the overlay's tumble duration, and
    // with no overlay the toast lands as soon as the server responds. Compress it
    // so the clatter finishes before the result rather than under it.
    const reducedMotion = prefersReducedMotion();
    tableAudioEngine.playTumble(
      tableAudioLevel,
      undefined,
      reducedMotion ? DICE_ROLL_REDUCED_MOTION_TUMBLE_MS : undefined,
    );
    if (reducedMotion) return;
    tumbleStartedAtRef.current = Date.now();
    rollIdRef.current += 1;
    const next: OverlayState = { id: rollIdRef.current, sides, phase: 'tumbling' };
    overlayRef.current = next;
    setOverlay(next);
  }, [clearSettleTimer, tableAudioLevel]);

  const cancelRollAnimation = useCallback(() => {
    clearSettleTimer();
    pendingShowRef.current = null;
    overlayRef.current = null;
    setOverlay(null);
  }, [clearSettleTimer]);

  const applyToast = useCallback((r: DiceRoll, options?: ShowRollOptions) => {
    // "Settle" cue + haptic: crit/fumble tones route via d20Flavor (plain rolls get
    // clatter only, no extra settle cue); the vibration fires on every settle
    // regardless of flavor, gated by the same preference plus prefers-reduced-motion
    // (haptics are treated as motion — see ../lib/tableAudio's shouldVibrate doc).
    tableAudioEngine.playSettleCue(d20Flavor(r), tableAudioLevel);
    vibrateIfEnabled(SETTLE_VIBRATION_PATTERN, tableAudioLevel, prefersReducedMotion());
    setRoll(r);
    setRollApplyHandler(options?.onApply ?? null);
    setRollApplyDisabled(options?.applyDisabled === true);
  }, [tableAudioLevel]);

  const showRoll = useCallback((r: DiceRoll, options?: ShowRollOptions) => {
    if (options?.onApply) setRollApplyHandler(options.onApply);

    if (prefersReducedMotion() || !overlayRef.current) {
      applyToast(r, options);
      return;
    }

    pendingShowRef.current = { roll: r, options };
    // Only the hold is gated here. The fall, bounce and settle that follow are
    // the bulk of the animation and are owned by the overlay itself.
    const wait = Math.max(0, DICE_ROLL_MIN_HOLD_MS - (Date.now() - tumbleStartedAtRef.current));

    const goSettle = () => {
      setOverlay((prev) => {
        if (!prev || prev.phase !== 'tumbling') return prev;
        return {
          ...prev,
          sides: options?.animationSides ?? prev.sides,
          phase: 'settling',
          values: r.rolls,
          keptFlags: keptFaceFlags(r),
          flavor: d20Flavor(r),
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

  const isOwnRoll = roll != null && me?.user?.id != null && String(roll.rollerUserId) === String(me.user.id);

  const canApply =
    !rollApplyDisabled &&
    isOwnRoll &&
    roll != null &&
    activeApplyHandler != null &&
    (rollApplyHandler != null || looksLikeDamageRoll(roll));

  const overlayDice = overlay
    ? buildOverlayDice(overlay.sides, overlay.values, overlay.keptFlags)
    : [];

  return (
    <RollResultToastContext.Provider
      value={{ beginRollAnimation, cancelRollAnimation, showRoll, setApplyDamageHandler }}
    >
      {children}
      {overlay && overlayDice.length > 0 && (
        <DiceRollOverlay
          key={overlay.id}
          dice={overlayDice}
          phase={overlay.phase}
          flavor={overlay.flavor ?? null}
          theme={me?.user?.diceTheme}
          colorVisionAssist={me?.user?.colorVisionAssist ?? false}
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
