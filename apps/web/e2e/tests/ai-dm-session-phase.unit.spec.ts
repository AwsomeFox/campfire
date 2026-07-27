/**
 * Session lifecycle phase, client side (issue #1043).
 *
 * THE BUG THESE GUARD. The server emits a thin `{type:'phase'}` frame and classifies it
 * broadcast-safe, but the web parser had no such member in its union and no `case` for it, so
 * `parseAiDmStreamEvent` dropped every phase frame through its `default` branch. Neither
 * `AiTablePage` nor `useAiDmLiveActivity` could therefore invalidate on it.
 *
 * The consequence was not cosmetic. Only the member who pressed Start Session / Wrap Up refetched
 * the session; everyone else kept a stale phase, and a player whose client still believed the
 * session was open would type, submit, and get a 409 they had no way to anticipate.
 *
 * Every sibling thin signal ('state', 'stuck', 'recovered', 'vote', 'takeover') already
 * invalidates, so these assertions hold `phase` to the same contract.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAiDmStreamEvent } from '../../src/lib/useAiDmStream';

const TABLE = resolve(__dirname, '../../src/features/ai-dm/AiTablePage.tsx');
const ACTIVITY = resolve(__dirname, '../../src/features/ai-dm/useAiDmLiveActivity.tsx');

const at = '2026-07-27T10:00:00.000Z';

test.describe('session lifecycle phase — client wiring (#1043)', () => {
  test('the parser returns the phase frame instead of dropping it', () => {
    for (const phase of ['greeting', 'active', 'wrap_up', 'ended']) {
      expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, phase, at })).toEqual({
        type: 'phase',
        campaignId: 1,
        phase,
        at,
      });
    }
  });

  test('a malformed phase frame is still dropped rather than half-parsed', () => {
    // Same contract as every sibling signal: structural validation, then narrow. A frame whose
    // payload is unusable must return null rather than reach a handler as `phase: undefined`.
    expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, at })).toBeNull();
    expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, phase: 7, at })).toBeNull();
    // Campaign scope + timestamp are required of every real event, as for all other frames.
    expect(parseAiDmStreamEvent({ type: 'phase', phase: 'ended', at })).toBeNull();
    expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, phase: 'ended' })).toBeNull();
  });

  test('an unknown phase name still parses, so an older client survives a newer server', () => {
    // Deliberately NOT an allowlist. The server owns the phase vocabulary; a client that dropped
    // a phase it did not recognise would skip the invalidation and go stale — the exact failure
    // this fixes. The refetched session is what the UI actually renders from.
    expect(parseAiDmStreamEvent({ type: 'phase', campaignId: 1, phase: 'intermission', at })).toMatchObject({
      type: 'phase',
      phase: 'intermission',
    });
  });

  test('both stream consumers invalidate the session on a phase frame', () => {
    // A member who did NOT press the button learns the phase changed only from this frame. If
    // either consumer omits it, that member keeps a stale phase and can type into an ended
    // session — the 409 they cannot anticipate.
    for (const file of [TABLE, ACTIVITY]) {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/event\.type === 'phase'/);
    }
  });
});
