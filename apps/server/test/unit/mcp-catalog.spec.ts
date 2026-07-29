import { MCP_CATALOG_COUNTS, MCP_TOOL_NAMES } from '../../src/modules/mcp/mcp-catalog';

describe('MCP catalog manifest (issue #483)', () => {
  it('exports counts that match the pinned tool list', () => {
    expect(MCP_CATALOG_COUNTS.tools).toBe(MCP_TOOL_NAMES.length);
    expect(MCP_CATALOG_COUNTS.resources).toBe(6);
    expect(MCP_CATALOG_COUNTS.prompts).toBe(2);
  });

  it('lists the authoritative death-save action', () => {
    expect(MCP_TOOL_NAMES).toContain('roll_death_save');
  });
});
