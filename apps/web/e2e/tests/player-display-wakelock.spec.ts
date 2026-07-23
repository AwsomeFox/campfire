import { expect, test, type Page } from '@playwright/test';
import { seed, stateFor } from './seed';

// ─── Wake Lock mock infrastructure ─────────────────────────────────────────

type WakeLockMockMode = 'supported' | 'unsupported' | 'denied';

interface MockSentinel {
  released: boolean;
  type: 'screen';
  onrelease: (() => void) | null;
  release: () => Promise<void>;
  addEventListener: (event: string, handler: () => void) => void;
  removeEventListener: (event: string, handler: () => void) => void;
}

async function installWakeLockMock(page: Page, mode: WakeLockMockMode = 'supported') {
  await page.addInitScript(
    ({ mockMode }) => {
      const sentinels: Array<{
        released: boolean;
        type: string;
        onrelease: (() => void) | null;
        release: () => Promise<void>;
        addEventListener: (event: string, handler: () => void) => void;
        removeEventListener: (event: string, handler: () => void) => void;
        _listeners: Array<() => void>;
      }> = [];

      if (mockMode === 'unsupported') {
        // Remove the wakeLock property entirely.
        Object.defineProperty(navigator, 'wakeLock', {
          configurable: true,
          get: () => undefined,
        });
      } else {
        const wakeLock = {
          request: async (type: string): Promise<MockSentinel> => {
            if (mockMode === 'denied') {
              throw new DOMException('User denied wake lock', 'NotAllowedError');
            }
            const listeners: Array<() => void> = [];
            const sentinel: MockSentinel & { _listeners: Array<() => void> } = {
              released: false,
              type: type as 'screen',
              onrelease: null,
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
      }

      // Expose test helpers.
      (window as typeof window & {
        __wakeLockTest: {
          getSentinelCount: () => number;
          getActiveSentinels: () => number;
          releaseAllExternally: () => void;
        };
      }).__wakeLockTest = {
        getSentinelCount: () => sentinels.length,
        getActiveSentinels: () => sentinels.filter((s) => !s.released).length,
        releaseAllExternally: () => {
          for (const s of sentinels) {
            if (!s.released) void s.release();
          }
        },
      };
    },
    { mockMode: mode },
  );
}

// Also install the fullscreen mock (the wake lock is tied to fullscreen state).
async function installFullscreenMock(page: Page, supported = true) {
  await page.addInitScript(
    ({ mockSupported }) => {
      let activeElement: Element | null = null;
      const change = () => document.dispatchEvent(new Event('fullscreenchange'));

      Object.defineProperty(document, 'fullscreenEnabled', {
        configurable: true,
        get: () => mockSupported,
      });
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => activeElement,
      });
      Object.defineProperty(Element.prototype, 'requestFullscreen', {
        configurable: true,
        value: mockSupported
          ? () => {
              activeElement = document.documentElement;
              change();
              return Promise.resolve();
            }
          : undefined,
      });
      Object.defineProperty(document, 'exitFullscreen', {
        configurable: true,
        value: mockSupported
          ? async () => {
              activeElement = null;
              change();
            }
          : undefined,
      });
    },
    { mockSupported: supported },
  );
}

async function openPlayerDisplay(page: Page, wakeLockMode: WakeLockMockMode = 'supported') {
  await installWakeLockMock(page, wakeLockMode);
  await installFullscreenMock(page);
  await page.goto(`/c/${seed().campaignId}/screen`);
  await expect(page.getByRole('heading', { name: 'E2E — Cinderhaven' })).toBeVisible();
}

function wakeLockNotice(page: Page) {
  return page.locator('.cf-screen-wakelock-notice');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test.describe('Player Display wake lock', () => {
  test.use({ storageState: stateFor('dm') });

  test('requests wake lock when fullscreen/presentation mode is activated', async ({ page }) => {
    await openPlayerDisplay(page);

    // Before entering fullscreen, no wake lock should be held.
    const beforeCount = await page.evaluate(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels(),
    );
    expect(beforeCount).toBe(0);

    // Enter fullscreen (which triggers wake lock).
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'true');

    // Wake lock should now be active.
    const afterCount = await page.evaluate(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels(),
    );
    expect(afterCount).toBe(1);

    // No notice should be visible (lock is working).
    await expect(wakeLockNotice(page)).not.toBeVisible();
  });

  test('releases wake lock when exiting fullscreen', async ({ page }) => {
    await openPlayerDisplay(page);

    // Enter fullscreen.
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'true');

    // Exit fullscreen.
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'false');

    // All sentinels should be released.
    const count = await page.evaluate(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels(),
    );
    expect(count).toBe(0);
  });

  test('degrades gracefully when Wake Lock API is unavailable', async ({ page }) => {
    await openPlayerDisplay(page, 'unsupported');

    // Enter fullscreen to trigger wake lock request.
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'true');

    // The notice should appear with guidance.
    await expect(wakeLockNotice(page)).toBeVisible();
    await expect(wakeLockNotice(page)).toContainText(/not supported.*power.*sleep settings|Wake Lock API/i);
    await expect(wakeLockNotice(page)).toHaveAttribute('role', 'status');
  });

  test('shows error message when wake lock request is denied', async ({ page }) => {
    await openPlayerDisplay(page, 'denied');

    // Enter fullscreen.
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'true');

    // The notice should show denial info.
    await expect(wakeLockNotice(page)).toBeVisible();
    await expect(wakeLockNotice(page)).toContainText(/denied|display sleep settings/i);
  });

  test('reacquires wake lock after visibility change (tab re-focused)', async ({ page }) => {
    await openPlayerDisplay(page);

    // Enter fullscreen.
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'true');

    // Verify lock is active.
    let active = await page.evaluate(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels(),
    );
    expect(active).toBe(1);

    // Simulate the browser releasing the lock (as happens when tab is backgrounded)
    // and then a visibility change back to 'visible'.
    await page.evaluate(() => {
      (window as typeof window & { __wakeLockTest: { releaseAllExternally: () => void } }).__wakeLockTest.releaseAllExternally();
    });

    // Wait for the release event to propagate.
    await page.waitForFunction(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels() === 0,
    );

    // Simulate visibility change back to 'visible'.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Wait for reacquisition.
    await page.waitForFunction(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels() === 1,
    );

    active = await page.evaluate(
      () => (window as typeof window & { __wakeLockTest: { getActiveSentinels: () => number } }).__wakeLockTest.getActiveSentinels(),
    );
    expect(active).toBe(1);
  });

  test('cleans up wake lock on navigation away', async ({ page }) => {
    await openPlayerDisplay(page);
    const { campaignId } = seed();

    // Enter fullscreen.
    await page.getByRole('button', { name: /fullscreen/i }).click();
    await expect(page.getByRole('button', { name: /fullscreen/i })).toHaveAttribute('aria-pressed', 'true');

    // Navigate away by exiting the display.
    await page.getByRole('button', { name: 'Exit player display' }).click();
    await expect(page).toHaveURL(`/c/${campaignId}`);

    // All sentinels should be released after unmount.
    const count = await page.evaluate(
      () => {
        const test = (window as typeof window & { __wakeLockTest?: { getActiveSentinels: () => number } }).__wakeLockTest;
        return test ? test.getActiveSentinels() : 0;
      },
    );
    expect(count).toBe(0);
  });
});
