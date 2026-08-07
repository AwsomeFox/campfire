/**
 * Table audio & haptics (issue #1920): every cue is synthesized client-side via
 * WebAudio primitives — no media assets ship in the image, and nothing is
 * fetched from anywhere. `tableAudio` is a single per-user preference
 * ('off' | 'low' | 'medium' | 'high') persisted via PATCH /me/preferences,
 * exactly like `diceTheme` and `animateOthersRolls` — see
 * apps/web/src/features/preferences/PreferencesPage.tsx.
 *
 * Design constraints this module exists to enforce:
 *  - Default off, and 'off' must produce literally zero WebAudio calls and zero
 *    `navigator.vibrate` calls — every cue entry point below checks the level
 *    first and returns before touching anything else.
 *  - Never autoplay: `TableAudioEngine` never constructs an `AudioContext`
 *    itself. A caller must invoke `unlock()` from a real user-gesture handler
 *    (see RollResultToastProvider's gesture listener) before `playTumble` /
 *    `playSettleCue` / `playTurnChime` can do anything — each is a silent
 *    no-op while unlocked === false.
 *  - Haptics are capability-checked (`canVibrate`) so iOS Safari — which has no
 *    Vibration API at all — degrades silently, never throws, never surfaces an
 *    error.
 *  - This module owns exactly one AudioContext for the whole app (the exported
 *    `tableAudioEngine` singleton). Call sites (RollResultToastContext,
 *    TurnWorkspace) only ever call `playTumble`/`playSettleCue`/`playTurnChime`/
 *    `vibrateIfEnabled` on it; only the gesture-listener wiring in
 *    RollResultToastProvider ever calls `unlock()`, so the context has exactly
 *    one owner and is never constructed twice.
 *
 * The fast web unit-test tier (playwright.unit.config.ts) is pure Node with no
 * DOM, so this module is split into two halves on purpose:
 *  - Pure, deterministic cue-parameter functions (`gainForLevel`, `tumbleTaps`,
 *    `settleCueTones`, `turnChimeTones`, `shouldVibrate`, `canVibrate`) that
 *    take every input explicitly (including the RNG) and are exhaustively
 *    tested in tableAudio.unit.spec.ts.
 *  - `TableAudioEngine`, whose AudioContext dependency is injected as a factory
 *    function rather than reached for globally (`new AudioContext()`), so the
 *    unit tier can inject a plain-object fake implementing `MinimalAudioContext`
 *    — no real Web Audio or DOM required — and assert gesture-gating
 *    mechanically (nothing constructed before unlock, correct node calls after).
 */
import type { TableAudioLevel } from '@campfire/schema';
import type { D20Flavor } from './d20Flavor';
import { DICE_ROLL_MIN_TUMBLE_MS } from '../components/DiceRollOverlay';

// TableAudioLevel is re-exported here so call sites that only touch this module
// don't need a separate @campfire/schema import for the type.
export type { TableAudioLevel };

/** Per-level peak gain. 'off' is handled separately (zero calls, not zero gain). */
const LEVEL_GAIN: Record<Exclude<TableAudioLevel, 'off'>, number> = {
  low: 0.12,
  medium: 0.22,
  high: 0.35,
};

/** Peak gain for a level; 0 for 'off' (callers must still skip entirely on 'off'). */
export function gainForLevel(level: TableAudioLevel): number {
  return level === 'off' ? 0 : LEVEL_GAIN[level];
}

export interface TumbleTap {
  /** Offset from cue start, in milliseconds. */
  offsetMs: number;
  /** Tap duration in milliseconds (short percussive burst). */
  durationMs: number;
  /** Oscillator frequency in Hz for this tap's short triangle-wave burst — higher = a sharper "clack". */
  freq: number;
  /** Peak gain for this tap, already scaled by level. */
  gain: number;
}

/**
 * 2-3 randomized taps spread across the tumble window (DICE_ROLL_MIN_TUMBLE_MS,
 * imported rather than re-declared so the two can never silently disagree).
 * `rng` defaults to Math.random but is injectable for deterministic tests.
 */
export function tumbleTaps(level: TableAudioLevel, rng: () => number = Math.random): TumbleTap[] {
  if (level === 'off') return [];
  const gain = gainForLevel(level);
  const count = rng() < 0.5 ? 2 : 3;
  const taps: TumbleTap[] = [];
  for (let i = 0; i < count; i++) {
    // Spread taps across the window with a little jitter so they don't sound
    // metronomic, but keep each firmly inside [0, DICE_ROLL_MIN_TUMBLE_MS).
    const slot = (DICE_ROLL_MIN_TUMBLE_MS / count) * i;
    const jitter = rng() * (DICE_ROLL_MIN_TUMBLE_MS / count) * 0.6;
    taps.push({
      offsetMs: Math.min(DICE_ROLL_MIN_TUMBLE_MS - 10, Math.round(slot + jitter)),
      durationMs: 30 + Math.round(rng() * 20),
      freq: 900 + Math.round(rng() * 900),
      gain: gain * (0.7 + rng() * 0.3),
    });
  }
  return taps;
}

export interface CueTone {
  /** Delay from cue start, in milliseconds. */
  offsetMs: number;
  durationMs: number;
  freq: number;
  gain: number;
  type: OscillatorType;
}

/** Nat-20: a bright two-note ascending sine sting. */
export function critCueTones(level: TableAudioLevel): CueTone[] {
  if (level === 'off') return [];
  const gain = gainForLevel(level);
  return [
    { offsetMs: 0, durationMs: 110, freq: 660, gain, type: 'sine' },
    { offsetMs: 90, durationMs: 220, freq: 880, gain, type: 'sine' },
  ];
}

/** Nat-1: a single low thud. */
export function fumbleCueTones(level: TableAudioLevel): CueTone[] {
  if (level === 'off') return [];
  return [{ offsetMs: 0, durationMs: 260, freq: 110, gain: gainForLevel(level), type: 'sine' }];
}

/** Your-turn edge: a soft two-tone chime, distinct from the crit sting (triangle, not sine). */
export function turnChimeTones(level: TableAudioLevel): CueTone[] {
  if (level === 'off') return [];
  const gain = gainForLevel(level) * 0.8;
  return [
    { offsetMs: 0, durationMs: 160, freq: 523.25, gain, type: 'triangle' },
    { offsetMs: 130, durationMs: 260, freq: 659.25, gain, type: 'triangle' },
  ];
}

/**
 * Routes a settle-time cue by d20Flavor: crit/fumble tones for a nat-20/nat-1,
 * or nothing at all for a plain roll (acceptance criterion — "plain rolls get
 * clatter only", no extra settle cue).
 */
export function settleCueTones(flavor: D20Flavor | null, level: TableAudioLevel): CueTone[] {
  if (flavor === 'crit') return critCueTones(level);
  if (flavor === 'fumble') return fumbleCueTones(level);
  return [];
}

/** Haptics are binary (on/off), not scaled by volume level — any non-'off' level enables them. */
export const SETTLE_VIBRATION_PATTERN = [30] as const;
export const YOUR_TURN_VIBRATION_PATTERN = [60, 40, 60] as const;

/** Feature-detect the Vibration API — absent entirely on iOS Safari. Never throws. */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/**
 * Whether a vibration call should fire: the preference must be enabled, the
 * platform must support it, and — per this feature's reduced-motion contract —
 * haptics are treated as motion, so `prefers-reduced-motion` gates them even
 * though it does NOT gate audio (audio remains opt-in via its own setting).
 */
export function shouldVibrate(level: TableAudioLevel, reducedMotion: boolean, vibrateSupported: boolean): boolean {
  return level !== 'off' && !reducedMotion && vibrateSupported;
}

/** Fires a vibration pattern only when every `shouldVibrate` condition holds. Never throws. */
export function vibrateIfEnabled(pattern: readonly number[], level: TableAudioLevel, reducedMotion: boolean): void {
  if (!shouldVibrate(level, reducedMotion, canVibrate())) return;
  navigator.vibrate(pattern as number[]);
}

// ---------- gesture-gated WebAudio driver ----------

/**
 * The minimal structural surface this module needs from a real
 * AudioContext/AudioParam/AudioNode — deliberately narrow (only the members
 * `scheduleTone`/`scheduleTap` below actually call), matching this repo's
 * `Pick<RealType, 'methodsActuallyUsed'>` test-double convention: a real
 * DOM AudioParam has far more members and satisfies this structurally with no
 * cast, while a plain-object test fake only has to implement exactly these.
 */
export interface MinimalAudioParam {
  setValueAtTime(value: number, startTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}
export interface MinimalAudioNode {
  connect(destination: MinimalAudioNode): void;
}
export interface MinimalGainNode extends MinimalAudioNode {
  gain: MinimalAudioParam;
}
export interface MinimalOscillatorNode extends MinimalAudioNode {
  type: OscillatorType;
  frequency: MinimalAudioParam;
  start(when?: number): void;
  stop(when?: number): void;
}
export interface MinimalAudioContext {
  currentTime: number;
  state: string;
  destination: MinimalAudioNode;
  createOscillator(): MinimalOscillatorNode;
  createGain(): MinimalGainNode;
  resume(): void | Promise<void>;
}

/**
 * Schedules one CueTone on a real (or fake, for tests) MinimalAudioContext: an
 * oscillator through a gain envelope (quick attack, exponential decay) so
 * every cue is a short, non-jarring blip rather than a hard on/off click.
 */
function scheduleTone(ctx: MinimalAudioContext, tone: CueTone): void {
  const start = ctx.currentTime + tone.offsetMs / 1000;
  const end = start + tone.durationMs / 1000;
  const osc = ctx.createOscillator();
  osc.type = tone.type;
  osc.frequency.setValueAtTime(tone.freq, start);
  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.exponentialRampToValueAtTime(Math.max(tone.gain, 0.0001), start + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gainNode);
  gainNode.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

/** Schedules one percussive tap as a short, sharply-decaying tone burst (the dice "clack"). */
function scheduleTap(ctx: MinimalAudioContext, tap: TumbleTap): void {
  scheduleTone(ctx, {
    offsetMs: tap.offsetMs,
    durationMs: tap.durationMs,
    freq: tap.freq,
    gain: tap.gain,
    type: 'triangle',
  });
}

/**
 * Owns the single app-wide AudioContext. Constructed with a FACTORY, not a
 * live AudioContext, so:
 *  - nothing is constructed at module-load time or before `unlock()`;
 *  - the unit-test tier can inject a plain-object fake with no DOM/real
 *    WebAudio involved at all.
 */
export class TableAudioEngine {
  private ctx: MinimalAudioContext | null = null;

  constructor(private readonly factory: () => MinimalAudioContext) {}

  /** True once a real user gesture has constructed the underlying context. */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Call ONLY from a user-gesture handler. Idempotent — a second call is a no-op. */
  unlock(): void {
    if (this.ctx) return;
    this.ctx = this.factory();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /**
   * Every playX method below is a silent no-op when the preference is off OR
   * the context hasn't been unlocked yet — this is the "never autoplay" gate:
   * even if a caller forgot to check the preference first, these refuse to
   * touch the AudioContext before a real gesture unlocked it.
   */

  /** Dice-clatter taps spread across the tumble window. */
  playTumble(level: TableAudioLevel, rng?: () => number): void {
    if (level === 'off' || !this.ctx) return;
    for (const tap of tumbleTaps(level, rng)) scheduleTap(this.ctx, tap);
  }

  /** Settle-time cue, routed by d20Flavor — null/plain rolls play nothing here. */
  playSettleCue(flavor: D20Flavor | null, level: TableAudioLevel): void {
    if (level === 'off' || !this.ctx) return;
    for (const tone of settleCueTones(flavor, level)) scheduleTone(this.ctx, tone);
  }

  /** Your-turn edge chime. */
  playTurnChime(level: TableAudioLevel): void {
    if (level === 'off' || !this.ctx) return;
    for (const tone of turnChimeTones(level)) scheduleTone(this.ctx, tone);
  }
}

/** Real-browser AudioContext factory — `webkitAudioContext` covers older Safari. */
function browserAudioContextFactory(): MinimalAudioContext {
  const Ctor: typeof AudioContext =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor() as unknown as MinimalAudioContext;
}

/**
 * Single app-wide instance (issue #1920 — see the ownership note in the module
 * doc comment above). Every call site imports this; only the gesture-listener
 * effect in RollResultToastProvider calls `unlock()`.
 */
export const tableAudioEngine = new TableAudioEngine(browserAudioContextFactory);
