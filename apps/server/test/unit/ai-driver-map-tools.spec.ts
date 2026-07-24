import { describe, it, expect } from '@jest/globals';
import { isDriverToolAllowed } from '../../src/modules/ai-driver/ai-driver.service';

/**
 * #488: The AI Driver seat could operate a fight (begin_encounter/next_turn/
 * add_combatant/update_combatant) but could not shape the battle map — every
 * map/VTT authoring tool defaulted to deny, so a driver-mode AI could not
 * spin up a random ambush and set up its own board.
 *
 * This suite pins the guarded live-play subset for map authoring:
 *  - `generate_map` — procedurally build a battle map (already DM-role-gated
 *    at the tool layer; produces a hidden attachment that must still be
 *    revealed explicitly through the encounter's fog/attachment machinery).
 *  - `update_encounter` — carries fog geometry, grid config, and shared AoE
 *    templates for live spatial play (also DM-role-gated).
 *  - `reveal_map_region` — remains on the allow-list (was added earlier).
 *
 * It also pins the boundary: hard deletes (`delete_*`), attachment-visibility
 * flips, and non-write map tools that don't exist stay blocked.
 */
describe('AI Driver battle-map tools (#488)', () => {
  const writeTool = (name: string) => ({ name, mutating: true, proposalCapable: false });

  it('allows generate_map — the driver can originate a battlefield in the flow of play', () => {
    expect(isDriverToolAllowed(writeTool('generate_map'))).toBe(true);
  });

  it('allows update_encounter — carries fog/grid/AoE for live spatial play', () => {
    expect(isDriverToolAllowed(writeTool('update_encounter'))).toBe(true);
  });

  it('keeps reveal_map_region allowed — the incremental fog-lift path', () => {
    expect(isDriverToolAllowed(writeTool('reveal_map_region'))).toBe(true);
  });

  it('still blocks delete_encounter — encounter destruction is never live-play work', () => {
    expect(isDriverToolAllowed(writeTool('delete_encounter'))).toBe(false);
  });

  it('still blocks delete_attachment — hidden handouts and generated maps cannot be purged by the seat', () => {
    // Even proposal-capable, the `delete_` prefix guard refuses.
    expect(isDriverToolAllowed({ name: 'delete_attachment', mutating: true, proposalCapable: true })).toBe(false);
  });

  it('still blocks update_attachment (attachment visibility) — revealing hidden handouts stays a DM decision', () => {
    // `update_attachment` is not on the allow-list; default-deny holds.
    expect(isDriverToolAllowed(writeTool('update_attachment'))).toBe(false);
  });

  it('exercises the full exploration -> combat map path (generate -> update -> reveal -> begin)', () => {
    // The whole map-authoring loop is reachable without a human intervention:
    //   1. generate_map (build the battle map)
    //   2. update_encounter (align grid / set fog)
    //   3. reveal_map_region (lift fog as the party explores)
    //   4. begin_encounter (start the fight)
    for (const name of ['generate_map', 'update_encounter', 'reveal_map_region', 'begin_encounter']) {
      expect(isDriverToolAllowed(writeTool(name))).toBe(true);
    }
  });
});
