import {
  describeWithheldTurn,
  FINISH_REASON_DELIVERY,
  isWithheldFinishReason,
  NARRATION_QUARANTINE_CHARS,
  NarrationQuarantine,
} from '../../src/modules/ai-driver/driver-safety';
import type { AiFinishReason } from '../../src/modules/ai-dm/providers/ai-provider';

/**
 * #598 — the pure half of "a provider refusal is a withheld turn, not a completed one".
 *
 * Everything here is dependency-free: no provider, no database, no session. The turn-loop
 * integration (nothing committed, nothing persisted, no tools dispatched) lives in the e2e
 * suite; this file pins the DECISION and the DELAY LINE.
 */
describe('finish-reason delivery disposition (#598)', () => {
  it('classifies every normalized finish reason exactly once', () => {
    // The map is typed `Record<AiFinishReason, …>`, so this list going stale is a compile
    // error at the map, not a silent gap. Asserting it here too makes the intent readable.
    expect(Object.keys(FINISH_REASON_DELIVERY).sort()).toEqual(
      ['content_filter', 'length', 'refusal', 'stop', 'tool_calls', 'unknown'].sort(),
    );
  });

  it('withholds ONLY the two safety terminal states', () => {
    const withheld = (Object.keys(FINISH_REASON_DELIVERY) as AiFinishReason[]).filter((r) =>
      isWithheldFinishReason(r),
    );
    expect(withheld.sort()).toEqual(['content_filter', 'refusal']);
  });

  it('delivers `unknown` — an unreportable provider is a reliability problem, not a safety one', () => {
    // Treating "we could not tell" as a refusal would file a safety incident for every
    // network blip and drown the real ones.
    expect(isWithheldFinishReason('unknown')).toBe(false);
    expect(isWithheldFinishReason('length')).toBe(false);
    expect(isWithheldFinishReason('tool_calls')).toBe(false);
  });

  it('treats a missing finish reason as deliverable, not as a refusal', () => {
    // A stream that ended with no `done` event is already classified as provider_error /
    // no_narration by the turn loop. Absence must not masquerade as a safety signal.
    expect(isWithheldFinishReason(undefined)).toBe(false);
  });

  it('never describes WHAT was withheld', () => {
    for (const reason of ['content_filter', 'refusal'] as const) {
      const text = describeWithheldTurn(reason);
      expect(text).toMatch(/withheld/i);
      expect(text).toMatch(/nothing was posted/i);
      // The neutral notice names the mechanism and the levers, never the content or a category
      // of content — describing it hands the table what the withhold exists to keep from them.
      expect(text).toMatch(/retry|continue without/i);
    }
    // The two causes are distinguishable to a reader without either naming content.
    expect(describeWithheldTurn('content_filter')).not.toBe(describeWithheldTurn('refusal'));
  });
});

describe('NarrationQuarantine — the streaming delay line (#598)', () => {
  it('holds back the trailing window and releases only what has aged out', () => {
    const q = new NarrationQuarantine(10);
    expect(q.push('0123456789')).toBe(''); // exactly the window — nothing is old enough yet
    expect(q.held).toBe(10);
    expect(q.push('abcde')).toBe('01234'); // five more arrived, so five are released
    expect(q.held).toBe(10);
    expect(q.flush()).toBe('56789abcde');
    expect(q.held).toBe(0);
  });

  it('releases everything on flush — a deliverable turn loses nothing', () => {
    const q = new NarrationQuarantine(240);
    const text = 'The torches gutter as the door swings wide.';
    const released = [q.push(text), q.flush()].join('');
    expect(released).toBe(text);
  });

  it('preserves byte-for-byte order across many small deltas', () => {
    const q = new NarrationQuarantine(16);
    const source = 'Rain hammers the shutters and the fire spits and the hall goes quiet.';
    let out = '';
    for (const ch of source) out += q.push(ch);
    out += q.flush();
    expect(out).toBe(source);
  });

  it('discard() drops the held tail and reports its size — the withheld path', () => {
    const q = new NarrationQuarantine(20);
    q.push('0123456789012345678901234'); // 25 chars: 5 released, 20 held
    expect(q.held).toBe(20);
    expect(q.discard()).toBe(20);
    expect(q.held).toBe(0);
    expect(q.flush()).toBe(''); // nothing survives a discard
  });

  it('a zero window is pass-through — the delay line can be switched off without breaking order', () => {
    const q = new NarrationQuarantine(0);
    expect(q.push('abc')).toBe('abc');
    expect(q.held).toBe(0);
    expect(q.flush()).toBe('');
  });

  it('ignores empty deltas rather than emitting empty frames', () => {
    const q = new NarrationQuarantine(4);
    expect(q.push('')).toBe('');
    expect(q.push('abcdef')).toBe('ab');
    expect(q.push('')).toBe('');
  });

  it('the default window is large enough to cover a multi-frame provider gap', () => {
    // The window exists because a provider reports its terminal state a handful of frames
    // AFTER the content that tripped it. A window smaller than a sentence would not span
    // that gap; one the size of a whole reply would just be buffering.
    expect(NARRATION_QUARANTINE_CHARS).toBeGreaterThanOrEqual(120);
    expect(NARRATION_QUARANTINE_CHARS).toBeLessThanOrEqual(1000);
    expect(new NarrationQuarantine().push('x'.repeat(NARRATION_QUARANTINE_CHARS))).toBe('');
  });
});
