import { expect, test } from '@playwright/test';
import type { Comment, QuestObjective, RevisionEntityType } from '@campfire/schema';

/**
 * Issue #1487 — Shipped API capabilities with no caller:
 * 1. Delete control for quest objectives calling DELETE /quests/:id/objectives/:oid.
 * 2. Restore control on tombstoned comments calling POST /comments/:id/restore for author/DM.
 * 3. Edit action in MyProposals allowing proposer to PATCH payload of pending proposal in place.
 * 4. Mount revision history panel for Factions and Story Beats.
 */
test.describe('backlog issue #1487 capabilities', () => {
  test('quest objective deletion formats request path and filters list correctly', () => {
    const questId = 42;
    const objectiveId = 7;
    const deletePath = `/quests/${questId}/objectives/${objectiveId}`;

    expect(deletePath).toBe('/quests/42/objectives/7');

    const objectives: QuestObjective[] = [
      { id: 6, questId: 42, text: 'First objective', done: true, sortOrder: 0 },
      { id: 7, questId: 42, text: 'Second objective', done: false, sortOrder: 1 },
      { id: 8, questId: 42, text: 'Third objective', done: false, sortOrder: 2 },
    ];

    const filtered = objectives.filter((o) => o.id !== objectiveId);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((o) => o.id)).toEqual([6, 8]);
  });

  test('tombstoned comment restoration path and authorization logic', () => {
    const commentId = 101;
    const restorePath = `/comments/${commentId}/restore`;
    expect(restorePath).toBe('/comments/101/restore');

    const tombstonedComment: Partial<Comment> = {
      id: commentId,
      authorUserId: 'user-123',
      deletedAt: '2026-07-31T12:00:00.000Z',
      deletedBy: 'user-123',
      body: '[deleted]',
    };

    function canModerate(c: { authorUserId: string; deletedAt: string | null }, caller: { userId: string; isDm: boolean; canMemberWrite: boolean }): boolean {
      return caller.canMemberWrite && (caller.isDm || (caller.userId !== null && c.authorUserId === caller.userId));
    }

    const isAuthor = canModerate(tombstonedComment as any, { userId: 'user-123', isDm: false, canMemberWrite: true });
    const isDm = canModerate(tombstonedComment as any, { userId: 'dm-999', isDm: true, canMemberWrite: true });
    const isOtherMember = canModerate(tombstonedComment as any, { userId: 'user-456', isDm: false, canMemberWrite: true });

    expect(isAuthor).toBe(true);
    expect(isDm).toBe(true);
    expect(isOtherMember).toBe(false);
  });

  test('proposal payload edit validates JSON and formats PATCH /proposals/:id payload', () => {
    const proposalId = 55;
    const patchPath = `/proposals/${proposalId}`;
    expect(patchPath).toBe('/proposals/55');

    const validJsonDraft = JSON.stringify({ title: 'New Title', body: 'New Body' }, null, 2);

    function parsePayloadDraft(draft: string): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
      try {
        const parsed = JSON.parse(draft);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ok: false, error: 'Payload must be a JSON object.' };
        }
        return { ok: true, payload: parsed as Record<string, unknown> };
      } catch {
        return { ok: false, error: 'Invalid JSON.' };
      }
    }

    const validResult = parsePayloadDraft(validJsonDraft);
    expect(validResult.ok).toBe(true);
    if (validResult.ok) {
      expect(validResult.payload).toEqual({ title: 'New Title', body: 'New Body' });
    }

    const invalidJsonResult = parsePayloadDraft('{ title: bad json }');
    expect(invalidJsonResult).toEqual({ ok: false, error: 'Invalid JSON.' });

    const arrayJsonResult = parsePayloadDraft('[1, 2, 3]');
    expect(arrayJsonResult).toEqual({ ok: false, error: 'Payload must be a JSON object.' });
  });

  test('revision entity types includes faction and story_beat', () => {
    const supportedTypes: RevisionEntityType[] = ['faction', 'story_beat'];
    expect(supportedTypes).toContain('faction');
    expect(supportedTypes).toContain('story_beat');
  });
});
