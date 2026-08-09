/**
 * Dice tumbling overlay (issue #1352). Shown while a local roll is in flight;
 * settles on the server-returned faces, then hands off to RollResultToast.
 *
 * The dice are the design project's physical 3D throw (see
 * ../features/dice/dice3d.ts): they hang spinning above the tray until the
 * server answers, then fall, bounce and come to rest with the rolled face up.
 * three.js is pulled in by dynamic import so it stays out of the entry chunk —
 * a table that never rolls never downloads it.
 *
 * The original CSS overlay is kept as the fallback for anything without a usable
 * WebGL context. It is not dead code: it is the only path on a locked-down
 * browser, a software-rendering VM, or a device that has already exhausted its
 * WebGL context budget, and it is what the unit tier renders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiceTheme } from '@campfire/schema';
import type { Dice3dHandle, Dice3dSettleDie } from '../features/dice/dice3d';
// Value import, so it must stay three.js-free — see the module doc there.
import { MAX_ANIMATION_MS } from '../features/dice/dice3dTiming';
import { flourishHeroIndex } from '../features/dice/natFlourish';
import { renderedDiceIndices } from '../features/dice/renderedDice';
import type { D20Flavor } from '../lib/d20Flavor';
import { prefersReducedMotion } from '../lib/prefersReducedMotion';

/**
 * Minimum time the dice stay in the air before they are allowed to fall. Short,
 * because the throw itself is another ~1.2s of tumble — this only guarantees the
 * dice were airborne at all when a fast server answers.
 */
export const DICE_ROLL_MIN_HOLD_MS = 300;
/**
 * Clatter window for the table-audio cue (../lib/tableAudio). Deliberately
 * longer than the hold: the taps should carry across the fall, not stop when the
 * dice are released.
 */
export const DICE_ROLL_MIN_TUMBLE_MS = 650;
/** CSS-fallback landing animation. */
export const DICE_ROLL_SETTLE_MS = 550;
/**
 * Backstop for the 3D path. requestAnimationFrame does not run in a background
 * tab, so without this a roll started and then backgrounded would never reach
 * `onSettled` and the result toast would never appear. It also covers the chunk
 * never arriving at all, where there is no roller to fail and no `catch` to fire.
 *
 * Derived from the roller's own budget rather than picked by hand: as a fixed
 * 4s it sat UNDER the animation it was guarding once a 60-die roll's stagger was
 * counted, and cut legitimate rolls off in mid-air.
 */
export const DICE_ROLL_MAX_SETTLE_MS = MAX_ANIMATION_MS + 1000;

export type DiceRollOverlayPhase = 'tumbling' | 'settling';

export interface DiceRollOverlayDie {
  sides: number;
  value?: number;
  kept: boolean;
}

function randomFace(sides: number): number {
  return 1 + Math.floor(Math.random() * sides);
}

/**
 * `keptFlags` are POSITIONAL — one per face, from ../lib/keptFaceFlags — not the
 * kept FACES the roll publishes. Matching faces here could not see a compound
 * roll's per-term structure, so `2d20kh1+1d4` faded nothing.
 */
export function buildOverlayDice(
  sides: number[],
  values?: number[],
  keptFlags?: boolean[],
): DiceRollOverlayDie[] {
  const count = values?.length ?? sides.length;
  return Array.from({ length: count }, (_, i) => ({
    sides: sides[i] ?? sides[sides.length - 1] ?? 20,
    value: values?.[i],
    kept: keptFlags?.[i] ?? true,
  }));
}

export function DiceRollOverlay({
  dice,
  phase,
  flavor = null,
  theme = 'nocturne',
  colorVisionAssist = false,
  onSettled,
}: {
  dice: DiceRollOverlayDie[];
  phase: DiceRollOverlayPhase;
  /**
   * Whether this roll crit or fumbled, from ../lib/d20Flavor — the app's single
   * answer, shared with the toast, the audio cue and the announcer. Deciding it
   * here from side counts made the tray flourish on pooled `2d20` rolls that
   * have no natural-result semantics at all.
   */
  flavor?: D20Flavor | null;
  theme?: DiceTheme | null;
  /**
   * Issue #1942: adds a star/skull glyph badge to the crit/fumble flourish so the
   * distinction survives with animations disabled (prefers-reduced-motion) and hue
   * ignored — this overlay is otherwise gold-glow vs red-glow only.
   */
  colorVisionAssist?: boolean;
  onSettled: () => void;
}) {
  // Locked for this roll. The overlay is keyed per roll, so a preference change
  // mid-flight belongs to the NEXT one — and letting it through here would tear
  // the throw down and restart it in mid-air.
  const [activeTheme] = useState<DiceTheme>(() => theme || 'nocturne');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handleRef = useRef<Dice3dHandle | null>(null);
  const settledRef = useRef(false);
  /** True once the 3D path has been ruled out — no WebGL, or the chunk failed. */
  const [cssFallback, setCssFallback] = useState(false);

  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  // Read by the effect that creates the roller, which cannot depend on either
  // without tearing the throw down and restarting it every time they change.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const settleResultsRef = useRef<Dice3dSettleDie[]>([]);
  const flavorRef = useRef<D20Flavor | null>(flavor);
  flavorRef.current = flavor;
  const settleOnce = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettledRef.current();
  }, []);

  /**
   * (Re)start the backstop clock.
   *
   * Armed once when the result arrives — covering a chunk request that hangs
   * without ever resolving or rejecting — and again the moment the dice are
   * actually released. Those are two different waits, and running them off one
   * clock started at the result meant a slow cold load ate the flight's budget:
   * the handle would arrive with less than a full animation left and get
   * unmounted before its dice landed.
   */
  const backstopRef = useRef<number | null>(null);
  const armBackstop = useCallback(() => {
    if (backstopRef.current != null) window.clearTimeout(backstopRef.current);
    backstopRef.current = window.setTimeout(settleOnce, DICE_ROLL_MAX_SETTLE_MS);
  }, [settleOnce]);
  useEffect(
    () => () => {
      if (backstopRef.current != null) window.clearTimeout(backstopRef.current);
    },
    [],
  );

  // Stable keys: the provider rebuilds `dice` on every render, so effects keyed
  // on the array identity alone would restart the throw continuously.
  const sidesKey = dice.map((d) => d.sides).join(',');
  const resultKey = dice.map((d) => `${d.sides}:${d.value ?? ''}:${d.kept ? 'k' : 'x'}`).join(',');

  const sides = useMemo(() => sidesKey.split(',').filter(Boolean).map(Number), [sidesKey]);
  const settleResults = useMemo<Dice3dSettleDie[]>(
    () =>
      resultKey
        .split(',')
        .filter(Boolean)
        .map((entry) => {
          const [, value, kept] = entry.split(':');
          return { value: Number(value) || 1, kept: kept === 'k' };
        }),
    [resultKey],
  );
  settleResultsRef.current = settleResults;

  // --- 3D path -------------------------------------------------------------

  useEffect(() => {
    if (cssFallback || sides.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let handle: Dice3dHandle | null = null;

    void import('../features/dice/dice3d')
      .then(({ startDiceRoll }) => {
        if (cancelled) return;
        handle = startDiceRoll(canvas, {
          sides,
          theme: activeTheme,
          reducedMotion: prefersReducedMotion(),
          onSettled: settleOnce,
        });
        if (!handle) {
          setCssFallback(true);
          return;
        }
        handleRef.current = handle;
        // A handle can be born into an already-settling roll: the chunk may still
        // have been loading when the server answered, or the roll's dice changed
        // at settle time (`animationSides`) and restarted this effect. Either way
        // the settle effect will not run again — its inputs did not change — so a
        // fresh handle that did not ask for the faces here would hold its dice in
        // the air until the backstop gave up on them.
        if (phaseRef.current === 'settling') {
          handle.settle(settleResultsRef.current, flavorRef.current);
          armBackstop();
        }
      })
      .catch(() => {
        if (!cancelled) setCssFallback(true);
      });

    return () => {
      cancelled = true;
      handleRef.current = null;
      handle?.dispose();
    };
  }, [cssFallback, sides, activeTheme, settleOnce, armBackstop]);

  useEffect(() => {
    if (cssFallback || phase !== 'settling') return;
    handleRef.current?.settle(settleResults, flavorRef.current);
    armBackstop();
  }, [cssFallback, phase, settleResults, armBackstop]);

  // --- CSS fallback --------------------------------------------------------

  const [faces, setFaces] = useState<number[]>(() => dice.map((d) => randomFace(d.sides)));

  useEffect(() => {
    if (!cssFallback || phase !== 'tumbling') return;
    const id = window.setInterval(() => {
      setFaces(sides.map((s) => randomFace(s)));
    }, 70);
    return () => window.clearInterval(id);
  }, [cssFallback, phase, sides]);

  useEffect(() => {
    if (!cssFallback || phase !== 'settling') return;
    const id = window.setTimeout(settleOnce, DICE_ROLL_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [cssFallback, phase, settleOnce]);

  const displayFaces = useMemo(() => {
    if (phase === 'settling') return dice.map((d) => d.value ?? 1);
    return faces;
  }, [phase, dice, faces]);

  if (dice.length === 0) return null;

  // The crit/fumble glyph badge rides on top of the canvas in the 3D path (the
  // flourish there is a gold or red flash, which is exactly the distinction
  // colorVisionAssist exists to back up) and on the die itself in the fallback.
  // The badge describes the die the roller actually lifted: same flavor, same
  // selection (a large roll draws only some of its dice), so it can never
  // announce a critical the tray never plays.
  const drawn = renderedDiceIndices(sides);
  const heroAt = phase === 'settling' ? flourishHeroIndex(flavor, drawn.map((i) => dice[i])) : -1;
  const overlayResult = heroAt >= 0 ? flavor : null;
  // Same die, in the fallback's own indexing.
  const fallbackHero = heroAt >= 0 ? drawn[heroAt] : -1;

  return (
    <div
      className="cf-dice-roll-overlay"
      data-testid="dice-roll-overlay"
      data-phase={phase}
      data-dice-theme={activeTheme}
      data-renderer={cssFallback ? 'css' : '3d'}
      // The 3D path draws the dice into a canvas, so this is the only DOM-level
      // record of what is actually being rolled. Kept on both paths so a check
      // does not silently pass on whichever renderer the machine happened to get.
      data-dice={sidesKey}
      role="presentation"
      aria-hidden="true"
    >
      {!cssFallback && (
        <div className="cf-dice-roll-overlay__tray">
          <canvas
            ref={canvasRef}
            className="cf-dice-roll-overlay__canvas"
            data-testid="dice-roll-overlay-canvas"
          />
          {colorVisionAssist && overlayResult && (
            <span
              className="cf-dice-roll-overlay__assist-glyph"
              data-testid="dice-roll-overlay-assist-glyph"
              data-result={overlayResult}
            >
              {overlayResult === 'crit' ? '★' : '💀'}
            </span>
          )}
        </div>
      )}
      {cssFallback && (
        <div className="cf-dice-roll-overlay__stage">
          {dice.map((die, i) => {
            const val = displayFaces[i];
            // The same die the 3D path would lift, on the same authority — not
            // "any face showing 20", which flourished on pooled rolls and on
            // dice a keep clause had thrown away.
            const isCrit = i === fallbackHero && flavor === 'crit';
            const isFumble = i === fallbackHero && flavor === 'fumble';

            return (
              <div
                key={i}
                className={[
                  'cf-dice-roll-overlay__die',
                  `cf-dice-roll-overlay__die--d${die.sides}`,
                  phase === 'settling' && !die.kept ? 'cf-dice-roll-overlay__die--dropped' : '',
                  isCrit ? 'cf-dice-roll-overlay__die--crit' : '',
                  isFumble ? 'cf-dice-roll-overlay__die--fumble' : '',
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
                    {val}
                  </span>
                  <span className="cf-dice-roll-overlay__type" aria-hidden="true">
                    d{die.sides}
                  </span>
                  {isCrit && <div className="cf-dice-roll-overlay__crit-ring" />}
                  {isFumble && <div className="cf-dice-roll-overlay__fumble-void" />}
                  {colorVisionAssist && (isCrit || isFumble) && (
                    <span
                      className="cf-dice-roll-overlay__assist-glyph"
                      data-testid="dice-roll-overlay-assist-glyph"
                      data-result={isCrit ? 'crit' : 'fumble'}
                    >
                      {isCrit ? '★' : '💀'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
