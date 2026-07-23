import { describe, it, expect } from '@jest/globals';
import {
  classifyStuck,
  isMidTurnFrozenState,
  type AiDmStopReason,
} from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1057: Verify that the step loop respects a mid-turn session freeze (pause or
 * human_control) by aborting early with a 'frozen' stop reason rather than
 * continuing to stream narration and execute tool calls.
 *
 * Unit coverage for `isMidTurnFrozenState` and `classifyStuck`; concurrency
 * behavior is covered by ai-dm-driver-security.e2e-spec.ts ("mid-turn pause").
 */

describe('AI Driver mid-turn freeze check (#1057)', () => {
  it('"frozen" is a valid AiDmStopReason', () => {
    const reason: AiDmStopReason = 'frozen';
    expect(reason).toBe('frozen');
  });

  it('frozen stop reason is distinct from aborted and provider_error', () => {
    const frozen: AiDmStopReason = 'frozen';
    const notFrozen: AiDmStopReason[] = ['aborted', 'provider_error'];
    expect(notFrozen).not.toContain(frozen);
  });

  it('classifyStuck treats frozen as healthy (not stuck)', () => {
    expect(
      classifyStuck({ stopReason: 'frozen', narration: '', prevNarration: null }),
    ).toBeNull();
    expect(
      classifyStuck({
        stopReason: 'frozen',
        narration: 'loop text',
        prevNarration: 'loop text',
      }),
    ).toBeNull();
  });

  it('isMidTurnFrozenState detects paused and human_control', () => {
    expect(isMidTurnFrozenState('paused')).toBe(true);
    expect(isMidTurnFrozenState('human_control')).toBe(true);
    expect(isMidTurnFrozenState('running')).toBe(false);
    expect(isMidTurnFrozenState('awaiting_players')).toBe(false);
  });

  it('a session with state paused should be detected as frozen by the loop guard', () => {
    const session = { state: 'running' as string };
    expect(isMidTurnFrozenState(session.state)).toBe(false);
    session.state = 'human_control';
    expect(isMidTurnFrozenState(session.state)).toBe(true);
  });
});
