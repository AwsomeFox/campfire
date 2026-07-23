/**
 * Issue #799 — install hint must not nag inside an installed standalone PWA.
 *
 * The bug (persona-audit, severity Low): `InstallHintBanner` keyed visibility
 * only on viewport width + localStorage dismissal, so the "Browser menu → Add
 * to Home Screen" card kept rendering after the user had already installed the
 * app (display-mode: standalone / iOS navigator.standalone).
 *
 * These specs pin the pure state model in `installHintState.ts`. The
 * component's job is to gather signals (matchMedia, beforeinstallprompt,
 * appinstalled, storage) and render the snapshot; every acceptance scenario
 * below is exercised without a browser.
 */
import { expect, test } from '@playwright/test';
import {
  DISMISS_KEY,
  detectInstallPlatform,
  installHintGuidance,
  isStandaloneMode,
  persistDismissed,
  readDismissed,
  resolveInstallHintStatus,
  shouldRenderInstallHint,
  type InstallHintSignals,
  type StorageLike,
} from '../../src/features/dashboard/installHintState';

function signals(partial: Partial<InstallHintSignals> = {}): InstallHintSignals {
  return {
    isMobileViewport: true,
    isStandalone: false,
    dismissed: false,
    hasNativePrompt: false,
    platform: 'android',
    ...partial,
  };
}

/** In-memory StorageLike; optionally throw on get/set for the unavailable-storage path. */
function memoryStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean; initial?: Record<string, string> } = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...(opts.initial ?? {}) };
  return {
    data,
    getItem(key: string) {
      if (opts.throwOnGet) throw new Error('storage blocked');
      return key in data ? data[key] : null;
    },
    setItem(key: string, value: string) {
      if (opts.throwOnSet) throw new Error('quota exceeded');
      data[key] = value;
    },
  };
}

test.describe('install hint state (issue #799)', () => {
  // --- Four-state model -----------------------------------------------------
  test.describe('resolveInstallHintStatus', () => {
    test('mobile browser (not installed, not dismissed) → installable', () => {
      // Acceptance: mobile browser shows the hint.
      const status = resolveInstallHintStatus(signals({ platform: 'android', isMobileViewport: true }));
      expect(status).toBe('installable');
      expect(shouldRenderInstallHint(status)).toBe(true);
    });

    test('installed PWA (display-mode standalone) → installed and not rendered', () => {
      // Acceptance: suppress in display-mode standalone.
      const status = resolveInstallHintStatus(signals({ isStandalone: true }));
      expect(status).toBe('installed');
      expect(shouldRenderInstallHint(status)).toBe(false);
    });

    test('standalone wins over a stale dismissed=false and over native prompt', () => {
      // Regression: an installed app must never show installable, even if the
      // browser still exposes a deferred prompt or dismiss was never written.
      const status = resolveInstallHintStatus(
        signals({ isStandalone: true, dismissed: false, hasNativePrompt: true }),
      );
      expect(status).toBe('installed');
      expect(shouldRenderInstallHint(status)).toBe(false);
    });

    test('user dismissal → dismissed and not rendered', () => {
      const status = resolveInstallHintStatus(signals({ dismissed: true }));
      expect(status).toBe('dismissed');
      expect(shouldRenderInstallHint(status)).toBe(false);
    });

    test('wide desktop viewport → unsupported (banner out of scope)', () => {
      const status = resolveInstallHintStatus(
        signals({ isMobileViewport: false, platform: 'desktop' }),
      );
      expect(status).toBe('unsupported');
      expect(shouldRenderInstallHint(status)).toBe(false);
    });

    test('narrow desktop viewport → installable with desktop guidance', () => {
      // Acceptance: narrow desktop still gets the hint (viewport match), with
      // desktop-specific copy rather than mobile "Add to Home Screen".
      const status = resolveInstallHintStatus(
        signals({ isMobileViewport: true, platform: 'desktop', hasNativePrompt: false }),
      );
      expect(status).toBe('installable');
      expect(shouldRenderInstallHint(status)).toBe(true);
      const guidance = installHintGuidance('desktop', false);
      expect(guidance.nativeActionLabel).toBeNull();
      expect(guidance.body.toLowerCase()).toContain('address-bar');
    });

    test('hasNativePrompt keeps status installable (prompt is a CTA, not a status)', () => {
      const status = resolveInstallHintStatus(signals({ hasNativePrompt: true }));
      expect(status).toBe('installable');
      expect(installHintGuidance('android', true).nativeActionLabel).toBe('Install');
    });

    test('reevaluate: leaving standalone is not modeled here — signals drive status', () => {
      // After installation the component sets isStandalone=true (appinstalled /
      // display-mode change). Flipping the signal must flip the status.
      const before = resolveInstallHintStatus(signals({ isStandalone: false }));
      const after = resolveInstallHintStatus(signals({ isStandalone: true }));
      expect(before).toBe('installable');
      expect(after).toBe('installed');
      expect(shouldRenderInstallHint(after)).toBe(false);
    });
  });

  // --- Standalone detection -------------------------------------------------
  test.describe('isStandaloneMode', () => {
    test('display-mode standalone alone counts as installed', () => {
      expect(isStandaloneMode({ displayModeStandalone: true })).toBe(true);
    });

    test('iOS navigator.standalone alone counts as installed', () => {
      // Acceptance: suppress in iOS standalone even when the CSS media query
      // does not match (legacy Safari behaviour).
      expect(
        isStandaloneMode({ displayModeStandalone: false, iosStandalone: true }),
      ).toBe(true);
    });

    test('browser tab (neither signal) is not standalone', () => {
      expect(
        isStandaloneMode({ displayModeStandalone: false, iosStandalone: false }),
      ).toBe(false);
    });
  });

  // --- Platform + guidance --------------------------------------------------
  test.describe('platform guidance', () => {
    test('iOS UA gets Share → Add to Home Screen copy (no native prompt)', () => {
      expect(detectInstallPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
      const g = installHintGuidance('ios', false);
      expect(g.body).toContain('Share');
      expect(g.body).toContain('Add to Home Screen');
      expect(g.nativeActionLabel).toBeNull();
    });

    test('iPadOS desktop-UA + touch maps to ios', () => {
      expect(
        detectInstallPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5),
      ).toBe('ios');
    });

    test('Android without native prompt gets menu install guidance', () => {
      expect(detectInstallPlatform('Mozilla/5.0 (Linux; Android 14)')).toBe('android');
      const g = installHintGuidance('android', false);
      expect(g.body.toLowerCase()).toContain('browser menu');
      expect(g.nativeActionLabel).toBeNull();
    });

    test('native prompt available → Install CTA instead of menu instructions', () => {
      // Acceptance: use native prompt when available.
      const g = installHintGuidance('android', true);
      expect(g.nativeActionLabel).toBe('Install');
      expect(g.body.toLowerCase()).not.toContain('browser menu');
    });

    test('desktop UA without touch maps to desktop', () => {
      expect(
        detectInstallPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 0),
      ).toBe('desktop');
    });
  });

  // --- Storage --------------------------------------------------------------
  test.describe('dismiss persistence', () => {
    test('readDismissed is true only when the flag is "1"', () => {
      const store = memoryStorage({ initial: { [DISMISS_KEY]: '1' } });
      expect(readDismissed(store)).toBe(true);
      expect(readDismissed(memoryStorage())).toBe(false);
    });

    test('persistDismissed writes the flag and reports success', () => {
      const store = memoryStorage();
      expect(persistDismissed(store)).toBe(true);
      expect(store.data[DISMISS_KEY]).toBe('1');
      expect(readDismissed(store)).toBe(true);
    });

    test('unavailable storage on read → not dismissed (banner can still show)', () => {
      // Acceptance: unavailable storage must not crash; treat as not dismissed.
      expect(readDismissed(memoryStorage({ throwOnGet: true }))).toBe(false);
      expect(readDismissed(null)).toBe(false);
      expect(readDismissed(undefined)).toBe(false);
    });

    test('unavailable storage on write → reports failure without throwing', () => {
      // Acceptance: dismiss still works in-memory (component sets dismissed);
      // persist is best-effort and returns false when storage throws / missing.
      expect(persistDismissed(memoryStorage({ throwOnSet: true }))).toBe(false);
      expect(persistDismissed(null)).toBe(false);
      // Status after an in-memory dismiss is still dismissed:
      expect(resolveInstallHintStatus(signals({ dismissed: true }))).toBe('dismissed');
    });
  });
});
