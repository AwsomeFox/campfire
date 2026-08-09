import { expect, test } from '@playwright/test';
import {
  archivedWriteBlockedReason,
  deriveCampaignAccess,
  isCampaignWritable,
} from '../../src/app/campaignAccess';

/**
 * Issue #704 — shared campaign writability mirrors server CampaignAccessService:
 * only `active` campaigns accept writes; paused/completed are read-only.
 */
test.describe('campaign access flags (issue #704)', () => {
  test('isCampaignWritable is true only for active status', () => {
    expect(isCampaignWritable({ status: 'active' })).toBe(true);
    expect(isCampaignWritable({ status: 'paused' })).toBe(false);
    expect(isCampaignWritable({ status: 'completed' })).toBe(false);
    expect(isCampaignWritable(null)).toBe(false);
  });

  test('deriveCampaignAccess gates writes by role and active status', () => {
    expect(deriveCampaignAccess('dm', { status: 'active' })).toMatchObject({
      isDm: true,
      writable: true,
      canDmWrite: true,
      canPlayerWrite: true,
      canMemberWrite: true,
    });
    expect(deriveCampaignAccess('dm', { status: 'paused' })).toMatchObject({
      isDm: true,
      writable: false,
      canDmWrite: false,
      canPlayerWrite: false,
      canMemberWrite: false,
    });
    expect(deriveCampaignAccess('player', { status: 'completed' })).toMatchObject({
      isPlayer: true,
      canPlayerWrite: false,
      canMemberWrite: false,
    });
    expect(deriveCampaignAccess('viewer', { status: 'active' })).toMatchObject({
      isViewer: true,
      canMemberWrite: false,
    });
    expect(deriveCampaignAccess(null, { status: 'active' })).toMatchObject({
      role: null,
      canDmWrite: false,
      canPlayerWrite: false,
      canMemberWrite: false,
    });
  });

  test('archivedWriteBlockedReason explains disabled controls', () => {
    expect(archivedWriteBlockedReason({ status: 'active' })).toBeNull();
    expect(archivedWriteBlockedReason({ status: 'paused' })).toBe(
      'This campaign is paused (archived, read-only).',
    );
    expect(archivedWriteBlockedReason({ status: 'completed' })).toBe(
      'This campaign is completed (archived, read-only).',
    );
  });
});

/**
 * Codex review on #2115 — `canMemberWrite` excludes viewers, which is right for surfaces the
 * product reserves for participants and WRONG for an endpoint the server opens to every
 * member. `POST /campaigns/:id/roll` runs `requireMemberOnWritableCampaign`, which asserts
 * membership and writability and no role floor, so a viewer who owns a character can roll
 * from their own sheet. The two flags must stay distinguishable.
 */
test.describe('canAnyMemberWrite — membership + writability, viewers included', () => {
  test('a viewer on an active campaign may write where the server allows any member', () => {
    const viewer = deriveCampaignAccess('viewer', { status: 'active' } as never);
    expect(viewer.canAnyMemberWrite).toBe(true);
    // ...and still cannot reach the participant-only surfaces.
    expect(viewer.canMemberWrite).toBe(false);
    expect(viewer.canPlayerWrite).toBe(false);
  });

  test('an archived campaign blocks every member regardless of role', () => {
    for (const role of ['dm', 'player', 'viewer'] as const) {
      expect(deriveCampaignAccess(role, { status: 'paused' } as never).canAnyMemberWrite).toBe(false);
    }
  });

  test('a non-member never qualifies', () => {
    expect(deriveCampaignAccess(null, { status: 'active' } as never).canAnyMemberWrite).toBe(false);
  });
});
