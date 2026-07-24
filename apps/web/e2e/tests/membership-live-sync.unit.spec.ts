import { test, expect } from '@playwright/test';
import {
  isMembershipSyncMessage,
  membershipSyncChannelName,
} from '../../src/lib/membershipLiveSync';

test.describe('membership live sync helpers (issue #437)', () => {
  test('channel name is scoped per user', () => {
    expect(membershipSyncChannelName(42)).toBe('campfire.membership.sync.42');
  });

  test('accepts well-formed membership.updated sync messages', () => {
    expect(
      isMembershipSyncMessage({ type: 'membership.updated', campaignId: 7, role: 'dm' }),
    ).toBe(true);
    expect(
      isMembershipSyncMessage({ type: 'membership.updated', campaignId: 7, role: 'player' }),
    ).toBe(true);
    expect(
      isMembershipSyncMessage({ type: 'membership.updated', campaignId: 7, role: 'viewer' }),
    ).toBe(true);
  });

  test('rejects malformed sync messages', () => {
    expect(isMembershipSyncMessage(null)).toBe(false);
    expect(isMembershipSyncMessage({ type: 'membership.revoked', campaignId: 7, role: 'dm' })).toBe(false);
    expect(isMembershipSyncMessage({ type: 'membership.updated', campaignId: '7', role: 'dm' })).toBe(false);
    expect(isMembershipSyncMessage({ type: 'membership.updated', campaignId: 7, role: 'admin' })).toBe(false);
    expect(isMembershipSyncMessage({ type: 'membership.updated', campaignId: 7 })).toBe(false);
  });
});
