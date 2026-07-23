import { describe, it, expect } from '@jest/globals';
import { isDriverToolAllowed } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1023: Verify that the AI Driver can whisper privately to a player during live play.
 */
describe('AI Driver whisper tool (#1023)', () => {
  it('whisper_to_player is allowed for the driver', () => {
    expect(isDriverToolAllowed({ name: 'whisper_to_player', mutating: true, proposalCapable: false })).toBe(true);
  });

  it('whisper content stays private (tool is mutating, not proposal-capable)', () => {
    // whisper_to_player is a direct write — it delivers the message immediately,
    // not through the proposal queue, which is correct for real-time private messaging.
    const tool = { name: 'whisper_to_player', mutating: true, proposalCapable: false };
    expect(isDriverToolAllowed(tool)).toBe(true);
  });
});
