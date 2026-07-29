import { test, expect } from '@playwright/test';
import { markAllReadSyncMessage } from '../../src/features/notifications/NotificationsBell';

test('mark-all publishes read-all even when the API returns affected ids', () => {
  expect(markAllReadSyncMessage('2026-07-29T17:30:00.000Z', [11, 12])).toEqual({
    type: 'read-all',
    readAt: '2026-07-29T17:30:00.000Z',
  });
});
