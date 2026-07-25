import { expect, test } from '@playwright/test';
import {
  captureListOrigin,
  labelForListReturnPath,
  preserveListOriginState,
  resolveDetailReturnTarget,
  safeCampaignListReturnPath,
} from '../../src/lib/detailListOrigin';

const campaignId = 7;

test.describe('detail list origin (issue #652)', () => {
  test('accepts campaign list and search surfaces for the same campaign', () => {
    expect(safeCampaignListReturnPath('/c/7/quests', campaignId)).toBe('/c/7/quests');
    expect(safeCampaignListReturnPath('/c/7/search?q=DLRNAV', campaignId)).toBe('/c/7/search?q=DLRNAV');
    expect(safeCampaignListReturnPath('/c/7/party?action=award-xp', campaignId)).toBe('/c/7/party?action=award-xp');
    expect(safeCampaignListReturnPath('/c/7', campaignId)).toBe('/c/7');
  });

  test('rejects other campaigns, detail routes, and unsafe paths', () => {
    expect(safeCampaignListReturnPath('/c/8/quests', campaignId)).toBeNull();
    expect(safeCampaignListReturnPath('/c/7/quests/11', campaignId)).toBeNull();
    expect(safeCampaignListReturnPath('//evil.example', campaignId)).toBeNull();
    expect(safeCampaignListReturnPath('/login', campaignId)).toBeNull();
  });

  test('derives explicit destination labels from list paths', () => {
    expect(labelForListReturnPath('/c/7/quests', campaignId)).toBe('← Back to quests');
    expect(labelForListReturnPath('/c/7/search?q=foo', campaignId)).toBe('← Back to search');
    expect(labelForListReturnPath('/c/7', campaignId)).toBe('← Back to dashboard');
  });

  test('resolves preserved list origin ahead of the default fallback', () => {
    const state = { listOrigin: { path: '/c/7/search?q=DLRNAV', scrollY: 240 } };
    expect(resolveDetailReturnTarget(state, campaignId, '/c/7/quests', '← Back to quests')).toEqual({
      to: '/c/7/search?q=DLRNAV',
      label: '← Back to search',
      scrollY: 240,
    });
  });

  test('falls back to the default list when no origin was captured', () => {
    expect(resolveDetailReturnTarget(null, campaignId, '/c/7/npcs', '← Back to NPCs')).toEqual({
      to: '/c/7/npcs',
      label: '← Back to NPCs',
    });
  });

  test('captureListOrigin records path and scroll at navigation time', () => {
    const origin = captureListOrigin({ pathname: '/c/7/quests', search: '?q=foo' });
    expect(origin.path).toBe('/c/7/quests?q=foo');
    expect(typeof origin.scrollY).toBe('number');
  });

  test('preserveListOriginState forwards an existing origin for detail hops', () => {
    const state = { listOrigin: { path: '/c/7/quests' } };
    expect(preserveListOriginState(state)).toEqual({ listOrigin: { path: '/c/7/quests' } });
    expect(preserveListOriginState(null)).toBeUndefined();
  });
});
