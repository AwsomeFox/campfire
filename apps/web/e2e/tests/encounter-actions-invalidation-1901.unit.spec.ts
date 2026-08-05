/**
 * Issue #1901 review (devin-ai-integration, PR #1951) — "Any character sheet change now
 * forces the whole open encounter view to reload."
 *
 * RunSessionPage's SSE handler used to call the broad `invalidateEncounter()` on every
 * `character.updated` frame (added so an equip/unequip change surfaces in the encounter's
 * usable actions promptly). That busts the ENTIRE `['encounter', id]` query subtree — the
 * encounter itself, its difficulty derivation, and its combat log/events — not just the two
 * reads a character change can actually affect (the per-combatant merged actions list and the
 * turn workspace's suggestedActions). During busy play (party rest follow-ups, HP edits,
 * several players editing sheets at once) that turned into a burst of redundant refetches on
 * the app's heaviest screen.
 *
 * These are functional tests against a real QueryClient (seeded with one query per read this
 * concerns), not just static-source assertions — so a regression back to the broad wipe fails
 * here even if someone re-inlines the call rather than reusing the helper by name.
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { queryKeys, invalidateEncounterActions } from '../../src/lib/query';

const RUN_SESSION_PAGE = resolve(__dirname, '../../src/features/encounters/RunSessionPage.tsx');

function seededClient(encounterId: number, combatantId: number) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.encounter(encounterId), { id: encounterId });
  client.setQueryData(queryKeys.encounterDifficulty(encounterId), { difficulty: 'medium' });
  client.setQueryData(queryKeys.encounterEvents(encounterId), []);
  client.setQueryData([...queryKeys.encounterTurn(encounterId), 1, combatantId], { suggestedActions: [] });
  client.setQueryData([...queryKeys.encounter(encounterId), 'actions', combatantId], []);
  return client;
}

function isInvalidated(client: QueryClient, key: readonly unknown[]): boolean {
  return client.getQueryState(key as unknown[])?.isInvalidated ?? false;
}

test.describe('invalidateEncounterActions scopes to derived action reads only (#1901)', () => {
  test('busts the per-combatant actions query and the turn workspace, not the encounter root/difficulty/events', () => {
    const encounterId = 42;
    const combatantId = 7;
    const client = seededClient(encounterId, combatantId);

    invalidateEncounterActions(client, encounterId);

    expect(isInvalidated(client, queryKeys.encounter(encounterId))).toBe(false);
    expect(isInvalidated(client, queryKeys.encounterDifficulty(encounterId))).toBe(false);
    expect(isInvalidated(client, queryKeys.encounterEvents(encounterId))).toBe(false);
    expect(isInvalidated(client, [...queryKeys.encounterTurn(encounterId), 1, combatantId])).toBe(true);
    expect(isInvalidated(client, [...queryKeys.encounter(encounterId), 'actions', combatantId])).toBe(true);
  });

  test('never touches a different encounter\'s cached reads', () => {
    const client = seededClient(42, 7);
    // A second encounter's actions query, present in the same cache.
    client.setQueryData([...queryKeys.encounter(99), 'actions', 7], []);

    invalidateEncounterActions(client, 42);

    expect(isInvalidated(client, [...queryKeys.encounter(99), 'actions', 7])).toBe(false);
  });

  test('RunSessionPage\'s character.updated branch calls the narrow helper, not the broad invalidateEncounter', () => {
    const source = readFileSync(RUN_SESSION_PAGE, 'utf8');
    const branchStart = source.indexOf('if (shouldInvalidateInlineCharacters(event)) {');
    expect(branchStart).toBeGreaterThan(-1);
    const branchEnd = source.indexOf('\n        }', branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = source.slice(branchStart, branchEnd);
    expect(branch).toContain('invalidateEncounterActions(queryClient, eid)');
    expect(branch).not.toMatch(/\binvalidateEncounter\(queryClient, eid\)/);
  });
});
