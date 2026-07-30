import { MCP_REST_PARITY_ISSUE_683 } from '../../src/modules/mcp/mcp-rest-parity';
import { McpToolsService } from '../../src/modules/mcp/mcp-tools';
import type { RequestUser } from '../../src/common/user.types';

describe('MCP REST parity manifest (#683)', () => {
  const user: RequestUser = {
    id: '1',
    name: 'parity-user',
    serverRole: 'user',
  };

  it('lists every issue-683 domain route with an MCP tool or documented REST-only gap', () => {
    expect(MCP_REST_PARITY_ISSUE_683.length).toBeGreaterThanOrEqual(30);
    for (const entry of MCP_REST_PARITY_ISSUE_683) {
      if (entry.mcpTool === null) {
        expect(entry.note).toMatch(/REST/i);
      } else {
        expect(entry.mcpTool).toMatch(/^[a-z_]+$/);
      }
    }
  });

  it('registers every mapped MCP tool on the server catalog', () => {
    const service = new McpToolsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // #588: OrganizedPlayService — injected only for toConflictResponse.
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      // #600: SessionZeroConsentService, appended last to the constructor.
      {} as never,
      // #1645: InboxSweepService, appended near-last to the constructor.
      {} as never,
      // #1645 review: throttler storage for MCP tool-level AI throttling.
      {} as never,
      // safetyCharterValidator
      {} as never,
    );
    const names = new Set(service.buildToolset(user).tools.map((t) => t.name));
    const missing = MCP_REST_PARITY_ISSUE_683.flatMap((entry) =>
      entry.mcpTool && !names.has(entry.mcpTool) ? [entry.mcpTool] : [],
    );
    expect(missing).toEqual([]);
  });
});
