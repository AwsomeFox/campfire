import { expect, test } from '@playwright/test';
import {
  FEED_NEAR_BOTTOM_PX,
  followLatestAfterUserScroll,
  isFeedNearBottom,
  unreadAfterFeedGrowth,
} from '../../src/features/ai-dm/feedScrollFollow';

test.describe('transcript feed scroll follow (#590)', () => {
  test('near-bottom threshold matches documented px budget', () => {
    expect(FEED_NEAR_BOTTOM_PX).toBeGreaterThan(0);
  });

  test('detects when the reader is pinned to the tail', () => {
    expect(isFeedNearBottom(952, 1000, 48, 48)).toBe(true);
    expect(isFeedNearBottom(800, 1000, 48, 48)).toBe(false);
  });

  test('increments unread only when not following and entries grow', () => {
    expect(unreadAfterFeedGrowth(0, true, 10, 12)).toBe(0);
    expect(unreadAfterFeedGrowth(2, false, 10, 12)).toBe(4);
    expect(unreadAfterFeedGrowth(2, false, 10, 10)).toBe(2);
  });

  test('user scroll at the tail re-enables follow mode', () => {
    expect(followLatestAfterUserScroll(true)).toBe(true);
    expect(followLatestAfterUserScroll(false)).toBe(false);
  });
});
