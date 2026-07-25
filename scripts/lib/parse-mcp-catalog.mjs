/**
 * Parse the canonical MCP catalog manifest (issue #483).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} src @param {string} constName */
function parseConstArray(src, constName) {
  const re = new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const`);
  const match = src.match(re);
  if (!match) {
    throw new Error(`parse-mcp-catalog: missing export const ${constName}`);
  }
  const names = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(`parse-mcp-catalog: ${constName} is empty`);
  }
  return names;
}

/** @param {string} root Repo root. */
export function loadMcpCatalog(root) {
  const catalogPath = join(root, 'apps/server/src/modules/mcp/mcp-catalog.ts');
  const src = readFileSync(catalogPath, 'utf8');
  const tools = parseConstArray(src, 'MCP_TOOL_NAMES');
  const resources = parseConstArray(src, 'MCP_RESOURCE_NAMES');
  const prompts = parseConstArray(src, 'MCP_PROMPT_NAMES');
  return {
    tools,
    resources,
    prompts,
    counts: {
      tools: tools.length,
      resources: resources.length,
      prompts: prompts.length,
    },
  };
}
