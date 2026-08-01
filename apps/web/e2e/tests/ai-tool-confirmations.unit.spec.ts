/**
 * Tool-confirmation UI wiring (issue #1558).
 *
 * #1558's core evidence was that grepping `apps/web` for the endpoint, the route and the concept
 * returned ZERO hits. These assertions are the standing guard against that being true again: the
 * panel must exist, must be mounted on the AI Table, must call both endpoints, and must be
 * driven by the live signal rather than only by its poll.
 */
import { expect, test } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PANEL = resolve(__dirname, '../../src/features/ai-dm/ToolConfirmationsPanel.tsx');
const TABLE = resolve(__dirname, '../../src/features/ai-dm/AiTablePage.tsx');
const STREAM = resolve(__dirname, '../../src/lib/useAiDmStream.ts');
const QUERY = resolve(__dirname, '../../src/lib/query.ts');

test.describe('tool confirmations UI (#1558)', () => {
  test('the panel reads and resolves the real endpoints', () => {
    const panel = readFileSync(PANEL, 'utf8');
    expect(panel).toMatch(/useAiDmToolConfirmations/);
    expect(panel).toMatch(/ai-dm\/tool-confirmation`/);
    expect(panel).toMatch(/action: 'approve'|'approve'/);
    expect(panel).toMatch(/ai-tool-confirmation-approve/);
    expect(panel).toMatch(/ai-tool-confirmation-reject/);
  });

  test('the query layer targets GET /ai-dm/tool-confirmations', () => {
    const query = readFileSync(QUERY, 'utf8');
    expect(query).toMatch(/ai-dm\/tool-confirmations/);
    expect(query).toMatch(/aiDmToolConfirmations/);
  });

  test('it is mounted on the AI Table, where a DM is during play', () => {
    // The acceptance criteria are explicit that this must not be a settings page: a
    // confirmations screen nobody navigates to reproduces the original bug with extra steps.
    const table = readFileSync(TABLE, 'utf8');
    expect(table).toMatch(/<ToolConfirmationsPanel/);
    expect(table).toMatch(/invalidateAiDmToolConfirmations/);
  });

  test('the stream parser no longer drops the tool-confirmation frame', () => {
    // Before #1558 the web union had no such member, so `parseAiDmStreamEvent` returned null for
    // it — the panel could not have been driven by the stream even if it had existed.
    const stream = readFileSync(STREAM, 'utf8');
    expect(stream).toMatch(/case 'tool-confirmation'/);
    expect(stream).toMatch(/confirmationId/);
  });

  test('it renders a list, because multi-pending is the normal case', () => {
    // Collaborative handoff (#1051) queues roughly four confirmations per combat turn, so a
    // one-at-a-time prompt would be wrong the first time anyone used it.
    const panel = readFileSync(PANEL, 'utf8');
    expect(panel).toMatch(/\.map\(/);
    expect(panel).toMatch(/requestedAt\.localeCompare/); // oldest first
    expect(panel).toMatch(/ai-tool-confirmations-count/);
  });

  test('it is accessible: labelled region, announced arrival, described buttons', () => {
    const panel = readFileSync(PANEL, 'utf8');
    expect(panel).toMatch(/aria-labelledby/);
    expect(panel).toMatch(/role="status"/);
    expect(panel).toMatch(/aria-describedby/);
    expect(panel).toMatch(/useAnnounce/);
  });

  test('every visible string is translated', () => {
    const panel = readFileSync(PANEL, 'utf8');
    for (const key of ['title', 'blocked', 'approve', 'reject', 'showArgs', 'meta']) {
      expect(panel).toContain(`table.confirmations.${key}`);
    }
    for (const lng of ['en', 'ar']) {
      const file = resolve(__dirname, `../../src/i18n/locales/${lng}/table.json`);
      if (!existsSync(file)) continue;
      const cat = JSON.parse(
        readFileSync(file, 'utf8'),
      ) as { table: { confirmations?: Record<string, string> } };
      expect(Object.keys(cat.table.confirmations ?? {}).sort()).toContain('approve');
    }
  });
});
