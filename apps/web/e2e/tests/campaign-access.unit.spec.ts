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
