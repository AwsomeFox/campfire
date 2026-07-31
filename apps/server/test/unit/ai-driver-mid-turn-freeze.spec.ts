import { describe, it, expect } from '@jest/globals';
import {
  classifyStuck,
  isMidTurnFrozenState,
} from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1057: Unit coverage for the predicates the step loop consults when a mid-turn session freeze
 * (pause or human_control) lands. The loop itself — aborting an in-flight turn with a 'frozen'
 * stop reason rather than continuing to stream narration and execute tool calls — is covered
 * end-to-end by ai-dm-driver-security.e2e-spec.ts ("mid-turn pause") and
 * ai-dm-driver-stop-controls.e2e-spec.ts; this file only pins the pure helpers.
 */

describe('AI Driver mid-turn freeze predicates (#1057)', () => {
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

  it('isMidTurnFrozenState reflects a human_control state mutation', () => {
    const session = { state: 'running' as string };
    expect(isMidTurnFrozenState(session.state)).toBe(false);
    session.state = 'human_control';
    expect(isMidTurnFrozenState(session.state)).toBe(true);
  });

  it('isMidTurnFrozenState reflects a paused state mutation', () => {
    const session = { state: 'running' as string };
    session.state = 'paused';
    expect(isMidTurnFrozenState(session.state)).toBe(true);
  });
});
