import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

async function installWakeLockMock(page: Page) {
  await page.addInitScript(() => {
    const sentinels: Array<{
      released: boolean;
      type: string;
      onrelease: (() => void) | null;
      release: () => Promise<void>;
      addEventListener: (event: string, handler: () => void) => void;
      removeEventListener: (event: string, handler: () => void) => void;
      _listeners: Array<() => void>;
    }> = [];

    const wakeLock = {
      request: async (type: string) => {
        const listeners: Array<() => void> = [];
        const sentinel = {
          released: false,
          type,
          onrelease: null as (() => void) | null,
          _listeners: listeners,
          release: async () => {
            if (!sentinel.released) {
              sentinel.released = true;
              for (const fn of listeners) fn();
              if (sentinel.onrelease) sentinel.onrelease();
            }
          },
          addEventListener: (_event: string, handler: () => void) => {
            listeners.push(handler);
          },
          removeEventListener: (_event: string, handler: () => void) => {
            const idx = listeners.indexOf(handler);
            if (idx >= 0) listeners.splice(idx, 1);
          },
        };
        sentinels.push(sentinel);
        return sentinel;
      },
    };

    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      get: () => wakeLock,
    });

    (window as typeof window & {
      __wakeLockTest: {
        getActiveSentinels: () => number;
      };
    }).__wakeLockTest = {
      getActiveSentinels: () => sentinels.filter((s) => !s.released).length,
    };
  });
}

test.describe('Encounter Runner wake lock (#1473)', () => {
  test.use({ storageState: stateFor('dm') });

  test('acquires wake lock while encounter is running and releases on unmount', async ({ page }) => {
    await installWakeLockMock(page);

    const { campaignId, encounterId } = seed();
    await page.goto(`/c/${campaignId}/encounters/${encounterId}`);

    // Wait for workspace to render.
    await expect(page.getByTestId('turn-workspace')).toBeVisible();

    // Verify wake lock is active while encounter is running.
    const activeSentinels = await page.evaluate(
      () => (window as typeof window & { __wakeLockTest?: { getActiveSentinels: () => number } }).__wakeLockTest?.getActiveSentinels(),
    );
    expect(activeSentinels).toBe(1);

    // Navigate away.
    await page.goto(`/c/${campaignId}`);
    await expect(page).toHaveURL(`/c/${campaignId}`);

    // Verify wake lock sentinel is released on unmount.
    await page.waitForFunction(
      () => {
        const testObj = (window as typeof window & { __wakeLockTest?: { getActiveSentinels: () => number } }).__wakeLockTest;
        return !testObj || testObj.getActiveSentinels() === 0;
      },
    );
  });
});
