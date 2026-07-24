/**
 * Install-hint visibility model (issue #799).
 *
 * The persona-audit finding: `InstallHintBanner` decided visibility from
 * viewport + localStorage dismissal alone, so the "Browser menu → Add to Home
 * Screen" card kept rendering inside an already-installed standalone PWA
 * (display-mode: standalone / iOS `navigator.standalone`). The instructions
 * are meaningless there and train users to distrust the banner.
 *
 * This module is the pure, DOM-free half of the fix (mirrors
 * `undoSnackbarState.ts` / `imageUploadState.ts`): it owns the four-state
 * model (unsupported / installable / installed / dismissed), standalone
 * detection, platform-specific guidance, and best-effort dismiss persistence.
 * The component owns the side-effectful bits — matchMedia listeners,
 * `beforeinstallprompt` / `appinstalled`, and calling the deferred native
 * prompt when the user taps Install.
 *
 * Why pure: every acceptance scenario (mobile browser, installed PWA, iOS
 * standalone, narrow desktop, unavailable storage) can be pinned in a
 * `.unit.spec.ts` without a browser.
 */

export const DISMISS_KEY = 'campfire.installHintDismissed';
export const MOBILE_QUERY = '(max-width: 768px)';
export const STANDALONE_QUERY = '(display-mode: standalone)';

/** Four-state model from the #799 acceptance criteria. */
export type InstallHintStatus = 'unsupported' | 'installable' | 'installed' | 'dismissed';

/** Coarse platform bucket used only for guidance copy when no native prompt. */
export type InstallPlatform = 'ios' | 'android' | 'desktop';

/** Observable inputs the component gathers from the environment. */
export interface InstallHintSignals {
  /** Narrow viewport — the banner is intentionally mobile-first. */
  isMobileViewport: boolean;
  /** Already running as an installed PWA (CSS or iOS standalone). */
  isStandalone: boolean;
  /** User previously dismissed the hint (localStorage, when available). */
  dismissed: boolean;
  /** A deferred `beforeinstallprompt` event is ready to call `.prompt()`. */
  hasNativePrompt: boolean;
  /** Platform for non-native guidance. */
  platform: InstallPlatform;
}

/** Copy the banner renders for the current platform / prompt availability. */
export interface InstallHintGuidance {
  title: string;
  body: string;
  /** Label for the native-prompt CTA; null when only manual guidance applies. */
  nativeActionLabel: string | null;
}

/** Minimal storage surface so tests can inject throwing / null storage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * True when the page is already an installed standalone app.
 *
 * Covers Chromium/Android/desktop PWAs via `display-mode: standalone` and
 * iOS Safari's legacy `navigator.standalone` boolean (which does not always
 * mirror the CSS media query).
 */
export function isStandaloneMode(opts: {
  displayModeStandalone: boolean;
  iosStandalone?: boolean;
}): boolean {
  return opts.displayModeStandalone || Boolean(opts.iosStandalone);
}

/**
 * Classify the UA into a guidance bucket. Pure: pass `maxTouchPoints` for the
 * iPadOS-13+ "Macintosh + touch" case rather than reading `navigator` here.
 */
export function detectInstallPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  // iPadOS 13+ desktop UA with touch still needs Share → Add to Home Screen.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'desktop';
}

/**
 * Resolve the four-state model from environment signals.
 *
 * Priority (highest first):
 *   1. installed  — standalone wins so an installed PWA never nags
 *   2. dismissed  — honor an explicit user dismissal
 *   3. unsupported — wide viewports are out of scope for this banner
 *   4. installable — mobile (or narrow) surface where install is relevant
 *
 * `hasNativePrompt` does not change the status (both native and manual paths
 * are `installable`); it only changes the guidance / CTA the component shows.
 */
export function resolveInstallHintStatus(signals: InstallHintSignals): InstallHintStatus {
  if (signals.isStandalone) return 'installed';
  if (signals.dismissed) return 'dismissed';
  if (!signals.isMobileViewport) return 'unsupported';
  return 'installable';
}

/** Whether the banner should mount any UI for the given status. */
export function shouldRenderInstallHint(status: InstallHintStatus): boolean {
  return status === 'installable';
}

/**
 * Platform-specific (or native) copy. When a deferred native prompt is held,
 * prefer a short CTA over browser-menu instructions — the Install button is
 * the real action.
 */
export function installHintGuidance(
  platform: InstallPlatform,
  hasNativePrompt: boolean,
): InstallHintGuidance {
  if (hasNativePrompt) {
    return {
      title: 'Install Campfire on this device',
      body: 'Install for offline access between sessions.',
      nativeActionLabel: 'Install',
    };
  }

  switch (platform) {
    case 'ios':
      return {
        title: 'Install Campfire on this device',
        body: 'Share → Add to Home Screen. Works offline between sessions.',
        nativeActionLabel: null,
      };
    case 'android':
      return {
        title: 'Install Campfire on this device',
        body: 'Browser menu → Install app / Add to Home Screen. Works offline between sessions.',
        nativeActionLabel: null,
      };
    case 'desktop':
      return {
        title: 'Install Campfire on this device',
        body: 'Browser menu or address-bar install icon → Install Campfire. Works offline between sessions.',
        nativeActionLabel: null,
      };
    default: {
      const _exhaustive: never = platform;
      void _exhaustive;
      return {
        title: 'Install Campfire on this device',
        body: 'Browser menu → Add to Home Screen. Works offline between sessions.',
        nativeActionLabel: null,
      };
    }
  }
}

/** Read the dismiss flag; missing / throwing storage ⇒ not dismissed. */
export function readDismissed(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Persist dismissal. Returns whether the write succeeded — a `false` result
 * still means the in-memory UI should hide (best-effort), but the hint may
 * reappear after reload when storage is unavailable (private mode / quota).
 */
export function persistDismissed(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    storage.setItem(DISMISS_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
