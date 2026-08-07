/**
 * Table audio & haptics (issue #1920) — pure-logic + wiring pins.
 *
 * This repo's fast unit tier (playwright.unit.config.ts) is pure Node with no
 * DOM, so — mirroring ui-icons.unit.spec.ts / monster-hp-display-control.unit.spec.ts —
 * this suite pins the feature three ways:
 *  1. The pure, deterministic cue-parameter functions (gainForLevel, tumbleTaps,
 *     critCueTones, fumbleCueTones, turnChimeTones, settleCueTones) and the pure
 *     haptics-capability/gating functions (canVibrate, shouldVibrate).
 *  2. `TableAudioEngine`'s gesture-gating and preference-gating, exercised
 *     against a plain-object fake implementing `MinimalAudioContext` — no real
 *     Web Audio or DOM involved, so this runs in pure Node.
 *  3. Source-text scans proving RollResultToastContext.tsx, TurnWorkspace.tsx,
 *     and PreferencesPage.tsx actually call into this module at the documented
 *     hook points, rather than the module existing unused. These scans prove
 *     ONLY that the call text is present and roughly where expected — they do
 *     not execute the component, so they cannot catch a wiring mistake that
 *     still contains the right substring (e.g. a call gated by the wrong
 *     variable). Behavioral coverage stops at (1) and (2) above.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canVibrate,
  critCueTones,
  fumbleCueTones,
  gainForLevel,
  settleCueTones,
  shouldVibrate,
  tumbleTaps,
  turnChimeTones,
  vibrateIfEnabled,
  TableAudioEngine,
  DICE_ROLL_REDUCED_MOTION_TUMBLE_MS,
  SETTLE_VIBRATION_PATTERN,
  YOUR_TURN_VIBRATION_PATTERN,
  type MinimalAudioContext,
  type MinimalAudioNode,
  type MinimalGainNode,
  type MinimalOscillatorNode,
} from '../../src/lib/tableAudio';
import { DICE_ROLL_MIN_TUMBLE_MS } from '../../src/components/DiceRollOverlay';

const ROLL_CONTEXT_FILE = resolve(__dirname, '../../src/components/RollResultToastContext.tsx');
const TURN_WORKSPACE_FILE = resolve(__dirname, '../../src/features/encounters/TurnWorkspace.tsx');
const PREFERENCES_PAGE_FILE = resolve(__dirname, '../../src/features/preferences/PreferencesPage.tsx');

test.describe('gainForLevel (issue #1920)', () => {
  test("'off' is exactly zero", () => {
    expect(gainForLevel('off')).toBe(0);
  });

  test('low < medium < high, all strictly positive', () => {
    const low = gainForLevel('low');
    const medium = gainForLevel('medium');
    const high = gainForLevel('high');
    expect(low).toBeGreaterThan(0);
    expect(medium).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(medium);
  });
});

test.describe('tumbleTaps (issue #1920)', () => {
  test("'off' produces zero taps regardless of rng — the silence contract", () => {
    expect(tumbleTaps('off', () => 0)).toEqual([]);
    expect(tumbleTaps('off', () => 0.99)).toEqual([]);
  });

  test('a constant rng of 0 deterministically produces exactly 2 clean-arithmetic taps', () => {
    // With rng() => 0 throughout: count = (0 < 0.5) -> 2; every jitter/duration-add/
    // freq-add term is rng()*k = 0, so every value collapses to its floor term —
    // hand-computable without replicating the implementation's formula.
    const taps = tumbleTaps('high', () => 0);
    const gain = gainForLevel('high');
    expect(taps).toHaveLength(2);
    expect(taps[0]).toEqual({ offsetMs: 0, durationMs: 30, freq: 900, gain: gain * 0.7 });
    expect(taps[1]).toEqual({ offsetMs: DICE_ROLL_MIN_TUMBLE_MS / 2, durationMs: 30, freq: 900, gain: gain * 0.7 });
  });

  test('a constant rng >= 0.5 selects the 3-tap branch, spread across the tumble window in order', () => {
    const taps = tumbleTaps('medium', () => 0.6);
    expect(taps).toHaveLength(3);
    for (const tap of taps) {
      expect(tap.offsetMs).toBeGreaterThanOrEqual(0);
      expect(tap.offsetMs).toBeLessThan(DICE_ROLL_MIN_TUMBLE_MS);
    }
    // Three taps generated from a CONSTANT rng each add the same jitter to a
    // strictly increasing slot — the offsets must come out strictly increasing.
    expect(taps[1].offsetMs).toBeGreaterThan(taps[0].offsetMs);
    expect(taps[2].offsetMs).toBeGreaterThan(taps[1].offsetMs);
  });

  test('an out-of-contract rng that would push a tap past the window is capped just inside it', () => {
    // A misbehaving rng returning 5 (outside the documented [0,1) contract) drives
    // slot+jitter for the last of 3 taps well past DICE_ROLL_MIN_TUMBLE_MS — the
    // implementation's safety cap must still keep every tap inside the window.
    const taps = tumbleTaps('low', () => 5);
    expect(taps).toHaveLength(3);
    for (const tap of taps) {
      expect(tap.offsetMs).toBeLessThan(DICE_ROLL_MIN_TUMBLE_MS);
    }
  });

  test('rng is threaded per-call (fresh draws per tap), not read once up front and reused for every tap', () => {
    // A steadily-incrementing rng (0, 0.05, 0.10, 0.15, ...) makes each of the 4
    // rng() draws per loop iteration (jitter/duration/freq/gain) distinct AND
    // makes iteration 0's draws distinct from iteration 1's — so if the
    // implementation cached a single rng() call before the loop and reused it
    // for every tap, durationMs/freq/gain would collapse to one repeated value
    // across taps instead of drifting upward with each iteration.
    let n = 0;
    const incrementing = () => (n++) * 0.05;
    const taps = tumbleTaps('medium', incrementing);
    expect(taps).toHaveLength(2);
    expect(taps[0].durationMs).not.toBe(taps[1].durationMs);
    expect(taps[0].freq).not.toBe(taps[1].freq);
    expect(taps[0].gain).not.toBe(taps[1].gain);
    // And they must drift upward (later draws are larger), not just differ.
    expect(taps[1].durationMs).toBeGreaterThan(taps[0].durationMs);
    expect(taps[1].freq).toBeGreaterThan(taps[0].freq);
    expect(taps[1].gain).toBeGreaterThan(taps[0].gain);
  });

  test('defaults to Math.random when no rng is supplied (still respects the off/non-off contract)', () => {
    expect(tumbleTaps('off')).toEqual([]);
    const taps = tumbleTaps('high');
    expect(taps.length === 2 || taps.length === 3).toBe(true);
  });
});

test.describe('critCueTones / fumbleCueTones / turnChimeTones (issue #1920)', () => {
  test("all three produce zero tones for 'off'", () => {
    expect(critCueTones('off')).toEqual([]);
    expect(fumbleCueTones('off')).toEqual([]);
    expect(turnChimeTones('off')).toEqual([]);
  });

  test('crit is a two-note ascending sine sting, distinct from fumble and the turn chime', () => {
    const crit = critCueTones('medium');
    expect(crit).toHaveLength(2);
    expect(crit.every((t) => t.type === 'sine')).toBe(true);
    expect(crit[1].freq).toBeGreaterThan(crit[0].freq);

    const fumble = fumbleCueTones('medium');
    expect(fumble).toHaveLength(1);
    expect(fumble[0].type).toBe('sine');
    // Fumble is a LOW thud — well below either crit note.
    expect(fumble[0].freq).toBeLessThan(crit[0].freq);

    const turn = turnChimeTones('medium');
    expect(turn).toHaveLength(2);
    // The chime uses a different timbre than the crit sting so a player can tell
    // "your turn" apart from "you just critted" by ear.
    expect(turn.every((t) => t.type === 'triangle')).toBe(true);
  });

  test('gain scales with level for every cue', () => {
    expect(critCueTones('low')[0].gain).toBeLessThan(critCueTones('high')[0].gain);
    expect(fumbleCueTones('low')[0].gain).toBeLessThan(fumbleCueTones('high')[0].gain);
    expect(turnChimeTones('low')[0].gain).toBeLessThan(turnChimeTones('high')[0].gain);
  });
});

test.describe('settleCueTones — d20Flavor routing (issue #1920 acceptance criterion)', () => {
  test('a crit flavor routes to critCueTones', () => {
    expect(settleCueTones('crit', 'medium')).toEqual(critCueTones('medium'));
  });

  test('a fumble flavor routes to fumbleCueTones', () => {
    expect(settleCueTones('fumble', 'medium')).toEqual(fumbleCueTones('medium'));
  });

  test('a plain roll (null flavor) plays NOTHING at settle — clatter only, per acceptance criteria', () => {
    expect(settleCueTones(null, 'high')).toEqual([]);
  });

  test("'off' silences even a crit/fumble flavor", () => {
    expect(settleCueTones('crit', 'off')).toEqual([]);
    expect(settleCueTones('fumble', 'off')).toEqual([]);
  });
});

test.describe('haptics capability + gating (issue #1920)', () => {
  // Node 22 defines a getter-only `navigator` accessor on globalThis (no setter),
  // so a plain `globalThis.navigator = ...` assignment silently no-ops. It IS
  // configurable, so Object.defineProperty can override it for a test and this
  // restores the original descriptor afterward.
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function setNavigator(value: unknown): void {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true, enumerable: true });
  }

  test.afterEach(() => {
    if (originalDescriptor) Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  });

  test('canVibrate is false with no navigator.vibrate function', () => {
    setNavigator({});
    expect(canVibrate()).toBe(false);
  });

  test('canVibrate is true when navigator.vibrate exists (desktop/iOS-Safari-shaped fake distinguished below)', () => {
    setNavigator({ vibrate: () => true });
    expect(canVibrate()).toBe(true);
  });

  test('shouldVibrate requires level enabled, motion allowed, AND platform support — every combination', () => {
    expect(shouldVibrate('off', false, true)).toBe(false);
    expect(shouldVibrate('low', true, true)).toBe(false); // reduced motion gates haptics too
    expect(shouldVibrate('low', false, false)).toBe(false); // unsupported platform (iOS Safari shape)
    expect(shouldVibrate('low', false, true)).toBe(true);
  });

  test('vibrateIfEnabled calls navigator.vibrate only when every gate passes, with the exact pattern', () => {
    const calls: number[][] = [];
    setNavigator({ vibrate: (p: number[]) => calls.push(p) });

    vibrateIfEnabled(SETTLE_VIBRATION_PATTERN, 'off', false);
    expect(calls).toHaveLength(0);

    vibrateIfEnabled(SETTLE_VIBRATION_PATTERN, 'low', true); // reduced motion blocks it
    expect(calls).toHaveLength(0);

    vibrateIfEnabled(YOUR_TURN_VIBRATION_PATTERN, 'high', false);
    expect(calls).toEqual([[60, 40, 60]]);
  });

  test('vibrateIfEnabled never throws when navigator.vibrate is entirely absent (iOS Safari)', () => {
    setNavigator({});
    expect(() => vibrateIfEnabled(SETTLE_VIBRATION_PATTERN, 'high', false)).not.toThrow();
  });
});

/** A plain-object fake satisfying MinimalAudioContext — no DOM/real WebAudio at all. */
class FakeAudioContext implements MinimalAudioContext {
  currentTime = 0;
  destination: MinimalAudioNode = { connect: () => {} };
  oscillatorCalls = 0;
  gainCalls = 0;
  resumeCalls = 0;

  constructor(public state: string = 'running') {}

  createOscillator(): MinimalOscillatorNode {
    this.oscillatorCalls++;
    return {
      type: 'sine',
      frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  createGain(): MinimalGainNode {
    this.gainCalls++;
    return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} };
  }

  resume(): void {
    this.resumeCalls++;
  }
}

test.describe('review fixes (issue #1920 review)', () => {
  test('unlock() stays locked and silent when the AudioContext factory throws, instead of escaping the gesture handler', () => {
    // A browser without AudioContext/webkitAudioContext, or one refusing to construct it, must
    // not take down the unrelated UI whose pointerdown handler called us. Staying locked is the
    // correct degraded state: every playX no-ops while ctx is null.
    const engine = new TableAudioEngine(() => {
      throw new Error('no WebAudio in this browser');
    });
    expect(() => engine.unlock()).not.toThrow();
    expect(engine.unlocked).toBe(false);
    // and it must still be silent afterwards rather than half-initialised
    expect(() => engine.playTurnChime('high')).not.toThrow();
  });

  test("vibrateIfEnabled does not touch navigator at all on the default 'off' path", () => {
    // The module's contract says 'off' returns before doing anything else. Calling canVibrate()
    // eagerly broke that quietly: it reads navigator on every roll for every user, including the
    // default-off majority. Asserted by making navigator access itself the failure.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    let touched = false;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get() {
        touched = true;
        return { vibrate: () => true };
      },
    });
    try {
      vibrateIfEnabled([10], 'off', false);
      expect(touched).toBe(false);
      // reduced-motion is the other short-circuit and must behave the same way
      vibrateIfEnabled([10], 'high', true);
      expect(touched).toBe(false);
      // control: an enabled, motion-allowed call DOES reach navigator
      vibrateIfEnabled([10], 'high', false);
      expect(touched).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});

test.describe('TableAudioEngine — gesture gating (issue #1920 acceptance criterion, mocked AudioContext)', () => {
  test('the factory is never called at construction time — no AudioContext before a gesture', () => {
    let factoryCalls = 0;
    new TableAudioEngine(() => {
      factoryCalls++;
      return new FakeAudioContext();
    });
    expect(factoryCalls).toBe(0);
  });

  test('playTumble/playSettleCue/playTurnChime touch nothing before unlock() — the never-autoplay gate', () => {
    let ctx: FakeAudioContext | null = null;
    const engine = new TableAudioEngine(() => {
      ctx = new FakeAudioContext();
      return ctx;
    });
    engine.playTumble('high');
    engine.playSettleCue('crit', 'high');
    engine.playTurnChime('high');
    expect(ctx).toBeNull();
    expect(engine.unlocked).toBe(false);
  });

  test('unlock() constructs the context exactly once, even across repeated calls', () => {
    let factoryCalls = 0;
    const engine = new TableAudioEngine(() => {
      factoryCalls++;
      return new FakeAudioContext();
    });
    engine.unlock();
    engine.unlock();
    engine.unlock();
    expect(factoryCalls).toBe(1);
    expect(engine.unlocked).toBe(true);
  });

  test('unlock() resumes a suspended context but not an already-running one', () => {
    const suspended = new FakeAudioContext('suspended');
    const suspendedEngine = new TableAudioEngine(() => suspended);
    suspendedEngine.unlock();
    expect(suspended.resumeCalls).toBe(1);

    const running = new FakeAudioContext('running');
    const runningEngine = new TableAudioEngine(() => running);
    runningEngine.unlock();
    expect(running.resumeCalls).toBe(0);
  });

  test("after unlock, playTumble('off') still plays nothing — preference gate holds even when unlocked", () => {
    const ctx = new FakeAudioContext();
    const engine = new TableAudioEngine(() => ctx);
    engine.unlock();
    engine.playTumble('off');
    expect(ctx.oscillatorCalls).toBe(0);
  });

  test('after unlock, playTumble schedules exactly one oscillator+gain pair per tap', () => {
    const ctx = new FakeAudioContext();
    const engine = new TableAudioEngine(() => ctx);
    engine.unlock();
    engine.playTumble('medium', () => 0); // deterministic: 2 taps (see tumbleTaps tests above)
    expect(ctx.oscillatorCalls).toBe(2);
    expect(ctx.gainCalls).toBe(2);
  });

  test('after unlock, playSettleCue(null, level) — a plain roll — schedules nothing', () => {
    const ctx = new FakeAudioContext();
    const engine = new TableAudioEngine(() => ctx);
    engine.unlock();
    engine.playSettleCue(null, 'high');
    expect(ctx.oscillatorCalls).toBe(0);
  });

  test('after unlock, playSettleCue("crit", level) schedules the 2-tone crit sting', () => {
    const ctx = new FakeAudioContext();
    const engine = new TableAudioEngine(() => ctx);
    engine.unlock();
    engine.playSettleCue('crit', 'high');
    expect(ctx.oscillatorCalls).toBe(2);
  });

  test('after unlock, playTurnChime schedules the 2-tone chime', () => {
    const ctx = new FakeAudioContext();
    const engine = new TableAudioEngine(() => ctx);
    engine.unlock();
    engine.playTurnChime('low');
    expect(ctx.oscillatorCalls).toBe(2);
  });
});

test.describe('RollResultToastContext wiring (issue #1920, source-text scan — structural, not behavioral)', () => {
  const text = readFileSync(ROLL_CONTEXT_FILE, 'utf8');

  test('the gesture-unlock effect is the only call site of tableAudioEngine.unlock()', () => {
    const unlockCalls = text.match(/tableAudioEngine\.unlock\(\)/g) ?? [];
    expect(unlockCalls).toHaveLength(1);
    expect(text).toContain("window.addEventListener('pointerdown', handleGesture, { once: true });");
    expect(text).toContain("window.addEventListener('keydown', handleGesture, { once: true });");
  });

  test('beginRollAnimation plays the tumble cue before the reduced-motion early return', () => {
    // The call is now multi-line (it passes a compressed window on the reduced-motion
    // path — Devin review on PR #2050), and the early return reads the hoisted
    // `reducedMotion` const rather than calling prefersReducedMotion() inline. The
    // INVARIANT is unchanged and is what this asserts: the cue is played before the
    // return, so audio still fires when the overlay is skipped.
    const tumbleIdx = text.indexOf('tableAudioEngine.playTumble(');
    const reducedMotionIdx = text.indexOf('if (reducedMotion) return;');
    expect(tumbleIdx).toBeGreaterThan(-1);
    expect(reducedMotionIdx).toBeGreaterThan(-1);
    expect(tumbleIdx).toBeLessThan(reducedMotionIdx);
  });

  test('applyToast (the settle moment) routes the cue through d20Flavor and fires the settle vibration', () => {
    expect(text).toContain('tableAudioEngine.playSettleCue(d20Flavor(r), tableAudioLevel);');
    expect(text).toContain('vibrateIfEnabled(SETTLE_VIBRATION_PATTERN, tableAudioLevel, prefersReducedMotion());');
  });
});

test.describe('TurnWorkspace wiring (issue #1920, source-text scan — structural, not behavioral)', () => {
  const text = readFileSync(TURN_WORKSPACE_FILE, 'utf8');

  test('the your-turn effect plays the chime and vibrates with the your-turn pattern', () => {
    expect(text).toContain('tableAudioEngine.playTurnChime(tableAudioLevel);');
    expect(text).toContain('vibrateIfEnabled(YOUR_TURN_VIBRATION_PATTERN, tableAudioLevel, prefersReducedMotion());');
  });

  test('the chime effect dedupes on encounter+actor+round, guarding against re-firing on an unrelated re-render', () => {
    expect(text).toContain('const key = `your-turn:${encounterId}:${currentId}:${turnRound}`;');
    expect(text).toContain('if (lastTurnCueKeyRef.current === key) return;');
  });
});

test.describe('PreferencesPage wiring (issue #1920, source-text scan — structural, not behavioral)', () => {
  const text = readFileSync(PREFERENCES_PAGE_FILE, 'utf8');

  test('the tableAudio control PATCHes /me/preferences with the selected level, immediately (like diceTheme)', () => {
    expect(text).toContain("await api.patch<User>(`${API}/me/preferences`, { tableAudio: level });");
    expect(text).toContain('id="prefs-table-audio"');
    expect(text).toContain('onChange={(e) => selectTableAudioLevel(e.target.value as TableAudioLevel)}');
  });

  test('the four levels are all offered as options', () => {
    for (const level of ['off', 'low', 'medium', 'high']) {
      expect(text).toContain(`<option value="${level}">`);
    }
  });
});

test.describe('reduced-motion clatter window (issue #1920, Devin review on PR #2050)', () => {
  test('every tap finishes inside the compressed window when the overlay is skipped', () => {
    // The default window is the OVERLAY's tumble duration. With reduced motion the
    // overlay never runs and the toast lands as soon as the server responds, so a
    // tap scheduled at ~640ms would still be rattling after the result is on screen
    // and would overlap the crit sting. Every tap must fit inside the short window.
    const taps = tumbleTaps('high', () => 0.9, DICE_ROLL_REDUCED_MOTION_TUMBLE_MS);
    expect(taps.length).toBeGreaterThan(0);
    for (const tap of taps) {
      expect(tap.offsetMs).toBeGreaterThanOrEqual(0);
      expect(tap.offsetMs).toBeLessThan(DICE_ROLL_REDUCED_MOTION_TUMBLE_MS);
    }
  });

  test('the default window is still the full overlay duration — the animated path is unchanged', () => {
    const taps = tumbleTaps('high', () => 0.9);
    expect(taps.some((t) => t.offsetMs > DICE_ROLL_REDUCED_MOTION_TUMBLE_MS)).toBe(true);
  });

  test('RollResultToastContext passes the compressed window on the reduced-motion path only', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/components/RollResultToastContext.tsx'),
      'utf8',
    );
    expect(src).toContain('DICE_ROLL_REDUCED_MOTION_TUMBLE_MS');
    expect(src).toMatch(/reducedMotion \? DICE_ROLL_REDUCED_MOTION_TUMBLE_MS : undefined/);
  });
});

test.describe('recovery from a browser-suspended context (issue #1920, Devin review on PR #2050)', () => {
  /** A fake whose context starts 'running', then gets suspended out from under us. */
  function suspendableEngine() {
    let resumeCalls = 0;
    const ctx = {
      state: 'running' as 'running' | 'suspended' | 'closed',
      currentTime: 0,
      destination: {} as MinimalAudioNode,
      createOscillator: () => ({ type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }) as unknown as MinimalOscillatorNode,
      createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }) as unknown as MinimalGainNode,
      resume: () => { resumeCalls += 1; return undefined; },
      close: () => {},
    } as unknown as MinimalAudioContext;
    const engine = new TableAudioEngine(() => ctx);
    engine.unlock();
    return { engine, ctx: ctx as unknown as { state: string }, resumeCalls: () => resumeCalls };
  }

  test('a cue best-effort resumes the context after the browser suspended it', () => {
    const { engine, ctx, resumeCalls } = suspendableEngine();
    const afterUnlock = resumeCalls();

    // The browser suspends it later in the page's life (iOS interruption, tab backgrounding).
    // unlock() already ran and `unlocked` is latched, so nothing re-arms it — without a
    // per-cue resume every later cue schedules against a frozen clock and is never heard.
    ctx.state = 'suspended';
    engine.playTurnChime('high');

    expect(resumeCalls()).toBeGreaterThan(afterUnlock);
  });

  test('a cue on an already-running context does not call resume again', () => {
    const { engine, resumeCalls } = suspendableEngine();
    const afterUnlock = resumeCalls();
    engine.playTurnChime('high');
    expect(resumeCalls()).toBe(afterUnlock);
  });

  test("a cue while the preference is off still never touches the context", () => {
    const { engine, ctx, resumeCalls } = suspendableEngine();
    const afterUnlock = resumeCalls();
    ctx.state = 'suspended';
    engine.playTurnChime('off');
    expect(resumeCalls()).toBe(afterUnlock);
  });
});
