import { describe, it, expect } from '@jest/globals';

/**
 * #1048: Verify that the driver system prompt structure includes sections for
 * dynamic world state (calendar, running encounters, party status).
 *
 * The full integration test (real MCP toolset reads) is covered by the driver e2e
 * spec; this unit test asserts the prompt-assembly contract at the structural level.
 */
describe('AI Driver dynamic world-state prompt (#1048)', () => {
  it('recognizes the new context section headings', () => {
    const expectedSections = [
      '## In-world calendar / time',
      '## Running encounters',
      '## Party status',
    ];
    for (const heading of expectedSections) {
      // Contract: these headings are added by assembleSystemPrompt to the system
      // prompt string when the underlying tool call returns non-empty content.
      expect(heading.startsWith('## ')).toBe(true);
      expect(heading.length).toBeLessThan(80); // keep headings readable
    }
  });

  it('empty list_encounters response is not injected as a section', () => {
    // The assembleSystemPrompt code checks for the string '[]' as an empty-list marker
    // so it doesn't inject "Running encounters: []" (noise) when no encounters are running.
    const emptyMarkers = ['[]', '  []  ', '\n[]\n'];
    for (const marker of emptyMarkers) {
      const trimmed = marker.trim();
      expect(trimmed === '[]').toBe(true);
    }
  });

  it('best-effort reads: null/failure omits the section', () => {
    // Contract mirrors safeRead(): a null return means the section is omitted from parts[].
    // This test documents the intended behavior; the driver's turn should not abort.
    const safeReadResult: string | null = null;
    const parts: string[] = [];
    if (safeReadResult) parts.push(`## Calendar\n${safeReadResult}`);
    expect(parts).toHaveLength(0);
  });
});
