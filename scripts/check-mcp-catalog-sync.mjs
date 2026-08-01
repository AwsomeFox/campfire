#!/usr/bin/env node
/**
 * CI guard for issue #483 — every MCP tool-count surface agrees with
 * apps/server/src/modules/mcp/mcp-catalog.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMcpCatalog } from './lib/parse-mcp-catalog.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { counts } = loadMcpCatalog(root);
const { tools, resources, prompts } = counts;
const errors = [];

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function expectContains(rel, fragment, label) {
  const content = read(rel);
  if (!content.includes(fragment)) {
    errors.push(`${rel} ${label}: expected ${JSON.stringify(fragment)}`);
  }
}

function expectGenerated() {
  const rel = 'apps/web/src/lib/mcp-catalog.generated.ts';
  const content = read(rel);
  const match = content.match(
    /tools:\s*(\d+),\s*resources:\s*(\d+),\s*prompts:\s*(\d+)/,
  );
  if (!match) {
    errors.push(`${rel} missing MCP_CATALOG_COUNTS block`);
    return;
  }
  const [genTools, genResources, genPrompts] = match.slice(1).map(Number);
  if (genTools !== tools) errors.push(`${rel} tools ${genTools} !== catalog ${tools}`);
  if (genResources !== resources) errors.push(`${rel} resources ${genResources} !== catalog ${resources}`);
  if (genPrompts !== prompts) errors.push(`${rel} prompts ${genPrompts} !== catalog ${prompts}`);
}

expectGenerated();

expectContains('README.md', `an MCP server (${tools} tools)`, 'root README MCP blurb');
expectContains('README.md', `server with **${tools} tools**`, 'root README status');
expectContains('README.md', `MCP server (${tools} tools)`, 'root README roadmap');

expectContains('apps/server/README.md', `**Tool catalog** (${tools} —`, 'server README catalog count');
expectContains('apps/server/README.md', 'modules/mcp/mcp-catalog.ts', 'server README catalog source');

expectContains('website/docs/index.md', `**${tools}-tool**`, 'docs home MCP card');
expectContains('website/docs/ai/capabilities.md', `server** (${tools} tools)`, 'capabilities intro');
expectContains('website/docs/ai/reference.md', `- **Tools:** ${tools} covering`, 'reference tools line');
expectContains('website/docs/ai/reference.md', `- **Resources:** ${resources} read surfaces`, 'reference resources line');
expectContains('website/docs/ai/reference.md', `- **Prompts:** ${prompts} authoring prompts`, 'reference prompts line');
expectContains('website/docs/reference/roadmap.md', `**Full MCP parity — ${tools} tools**`, 'roadmap tools line');
expectContains(
  'website/docs/reference/roadmap.md',
  `${resources} read surfaces plus ${prompts} prep/recap prompts, beyond the ${tools}-tool set`,
  'roadmap resources/prompts line',
);

for (const rel of [
  'apps/web/src/i18n/locales/en/preferences.json',
  'apps/web/src/i18n/locales/ar/preferences.json',
]) {
  if (!existsSync(join(root, rel))) continue;
  expectContains(rel, '{{toolCount}} tools covering', 'preferences mcpBlurb interpolation');
  if (read(rel).match(/\b\d+\+?\s+tools covering/)) {
    errors.push(`${rel} still hardcodes a tool count — use {{toolCount}}`);
  }
}

// Historical drift magnets — must not reappear.
const forbidden = [
  ['README.md', /\b130\+\s+tools\b/],
  ['README.md', /\b137\s+tools\b/],
  ['website/docs/index.md', /\b137-tool\b/],
  ['website/docs/ai/reference.md', /\b130\+\b/],
  ['apps/web/src/i18n/locales/en/preferences.json', /\b36\+\s+tools\b/],
];

for (const [rel, pattern] of forbidden) {
  if (pattern.test(read(rel))) {
    errors.push(`${rel} still contains stale hardcoded MCP count (${pattern})`);
  }
}

if (errors.length > 0) {
  console.error('check-mcp-catalog-sync: MCP catalog surfaces disagree:\n- ' + errors.join('\n- '));
  console.error('\nRun: npm run generate:mcp-catalog');
  process.exit(1);
}

console.log(
  `check-mcp-catalog-sync: ok — ${tools} tools, ${resources} resources, ${prompts} prompts`,
);
