/**
 * Unit test for the AI Driver live-play allow-list (issue #1067).
 * Verifies that scene-transition tools are accessible to the driver.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('DRIVER_LIVE_PLAY_TOOLS allow-list', () => {
  const serviceSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/modules/ai-driver/ai-driver.service.ts'),
    'utf-8',
  );

  // Extract the tool names from the DRIVER_LIVE_PLAY_TOOLS set declaration.
  const toolNamesMatch = serviceSource.match(
    /DRIVER_LIVE_PLAY_TOOLS.*?=.*?new Set\(\[([\s\S]*?)\]\)/,
  );
  const toolNames: string[] = toolNamesMatch
    ? [...toolNamesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];

  it('includes set_location_discovery for scene transitions (#1067)', () => {
    expect(toolNames).toContain('set_location_discovery');
  });

  it('includes reveal_map_region for exploration', () => {
    expect(toolNames).toContain('reveal_map_region');
  });

  it('includes set_npc_disposition for social scenes (#1069)', () => {
    expect(toolNames).toContain('set_npc_disposition');
  });

  it('does NOT include update_campaign (bulk settings edit is not a live-play action)', () => {
    expect(toolNames).not.toContain('update_campaign');
  });

  it('does NOT include any delete_ tool (forbidden prefix)', () => {
    const deletes = toolNames.filter((t) => t.startsWith('delete_'));
    expect(deletes).toEqual([]);
  });
});
