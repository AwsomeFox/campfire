import { describe, it, expect } from '@jest/globals';
import { isDriverToolAllowed } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #1023: Verify that the AI Driver can whisper privately to a player during live play.
 * Allow-list coverage only — recipient scoping is asserted in the driver e2e suite.
 */
describe('AI Driver whisper tool allow-list (#1023)', () => {
  const writeTool = (name: string) => ({ name, mutating: true, proposalCapable: false });

  it('whisper_to_player is allowed as a direct live-play write', () => {
    // Direct write (not proposal-capable): real-time private messaging must land
    // immediately under DRIVER_LIVE_PLAY_TOOLS, same as award_xp.
    expect(isDriverToolAllowed(writeTool('whisper_to_player'))).toBe(true);
  });

  it('a mutating non-proposal tool off the live-play list remains refused', () => {
    expect(isDriverToolAllowed(writeTool('update_campaign'))).toBe(false);
    expect(isDriverToolAllowed(writeTool('approve_proposal'))).toBe(false);
  });

  it('filters a simulated catalog to include whisper while excluding admin/destructive tools', () => {
    const catalog = [
      writeTool('whisper_to_player'),
      writeTool('award_xp'),
      writeTool('adjust_treasury'),
      writeTool('add_inventory_item'),
      writeTool('update_campaign'),
      writeTool('approve_proposal'),
      writeTool('delete_note'),
    ];

    const allowed = catalog.filter((t) => isDriverToolAllowed(t)).map((t) => t.name);
    expect(allowed).toEqual([
      'whisper_to_player',
      'award_xp',
      'adjust_treasury',
      'add_inventory_item',
    ]);
    expect(allowed).not.toContain('update_campaign');
    expect(allowed).not.toContain('approve_proposal');
    expect(allowed).not.toContain('delete_note');
  });
});
