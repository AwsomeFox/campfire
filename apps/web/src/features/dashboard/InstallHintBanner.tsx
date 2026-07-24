/**
 * "Install Campfire on this device" hint — design/claude-design/Campfire.dc.html ~L427-433
 * (installCard). Visibility is client-side only (issue #799): suppressed in
 * standalone/iOS standalone, dismissed via localStorage when available, and
 * shown on narrow viewports with either a native install prompt or
 * platform-specific guidance. See `installHintState.ts` for the pure model.
 *
 * The deferred `beforeinstallprompt` event lives in module scope
 * (`deferredInstallPrompt.ts`) so client-side navigation away from the
 * dashboard does not discard installability for the rest of the document load.
 */
import { useEffect, useState } from 'react';
import {
  clearDeferredInstallPrompt,
  ensureDeferredInstallPromptCapture,
  getDeferredInstallPrompt,
  setDeferredInstallPrompt,
  subscribeDeferredInstallPrompt,
  type DeferredInstallPrompt,
} from './deferredInstallPrompt';
import {
  MOBILE_QUERY,
  STANDALONE_QUERY,
  detectInstallPlatform,
  installHintGuidance,
  isStandaloneMode,
  persistDismissed,
  readDismissed,
  resolveInstallHintStatus,
  shouldRenderInstallHint,
  type InstallPlatform,
} from './installHintState';

function readIosStandalone(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true;
}

function readPlatform(): InstallPlatform {
  return detectInstallPlatform(
    window.navigator.userAgent,
    window.navigator.maxTouchPoints ?? 0,
  );
}

export function InstallHintBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return readDismissed(window.localStorage);
    } catch {
      return false;
    }
  });
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false,
  );
  const [isStandalone, setIsStandalone] = useState(() =>
    typeof window !== 'undefined'
      ? isStandaloneMode({
          displayModeStandalone: window.matchMedia(STANDALONE_QUERY).matches,
          iosStandalone: readIosStandalone(),
        })
      : false,
  );
  // Seed from module scope so a remount after navigation keeps the CTA.
  const [nativePrompt, setNativePrompt] = useState<DeferredInstallPrompt | null>(
    () => getDeferredInstallPrompt(),
  );
  const [platform] = useState<InstallPlatform>(() =>
    typeof window !== 'undefined' ? readPlatform() : 'desktop',
  );

  // Reevaluate when viewport, display-mode, or install lifecycle changes.
  useEffect(() => {
    ensureDeferredInstallPromptCapture();
    setNativePrompt(getDeferredInstallPrompt());

    const mobileMql = window.matchMedia(MOBILE_QUERY);
    const standaloneMql = window.matchMedia(STANDALONE_QUERY);

    const syncViewport = () => setIsMobile(mobileMql.matches);
    const syncStandalone = () => {
      setIsStandalone(
        isStandaloneMode({
          displayModeStandalone: standaloneMql.matches,
          iosStandalone: readIosStandalone(),
        }),
      );
    };

    const onAppInstalled = () => {
      setIsStandalone(true);
    };

    const unsubPrompt = subscribeDeferredInstallPrompt(setNativePrompt);

    syncViewport();
    syncStandalone();
    mobileMql.addEventListener('change', syncViewport);
    standaloneMql.addEventListener('change', syncStandalone);
    // appinstalled also clears the module-scoped prompt; keep a local listener
    // so standalone flips even if the banner was already showing.
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      // Intentionally leave the deferred prompt in module scope — unmount must
      // not discard installability for a later remount on this document load.
      unsubPrompt();
      mobileMql.removeEventListener('change', syncViewport);
      standaloneMql.removeEventListener('change', syncStandalone);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const status = resolveInstallHintStatus({
    isMobileViewport: isMobile,
    isStandalone,
    dismissed,
    hasNativePrompt: nativePrompt !== null,
    platform,
  });

  if (!shouldRenderInstallHint(status)) return null;

  const guidance = installHintGuidance(platform, nativePrompt !== null);

  function dismiss() {
    setDismissed(true);
    try {
      persistDismissed(window.localStorage);
    } catch {
      // best-effort only — in-memory dismiss still hides for this session
    }
  }

  async function installNative() {
    if (!nativePrompt) return;
    const deferred = nativePrompt;
    // Keep the deferred prompt until prompt() successfully starts — a failed
    // call (gesture timing, transient browser refusal) must remain retryable.
    try {
      await deferred.prompt();
      // Chromium consumes the event once prompt() resolves; drop it from module
      // scope so remounts do not offer a dead CTA.
      clearDeferredInstallPrompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'accepted') {
        // appinstalled listener also flips standalone; set eagerly for snappy UI.
        setIsStandalone(true);
      }
    } catch {
      // Restore module scope so the Install CTA stays available for a retry.
      if (getDeferredInstallPrompt() === null) {
        setDeferredInstallPrompt(deferred);
      }
      setNativePrompt(deferred);
    }
  }

  return (
    <div
      role="region"
      aria-label={guidance.title}
      data-has-native-prompt={nativePrompt !== null ? 'true' : 'false'}
      data-install-platform={platform}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        border: '1px solid var(--color-accent-800)',
        borderRadius: 'var(--radius-md)',
        background: 'color-mix(in srgb, var(--color-accent) 6%, transparent)',
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flex: 'none', color: 'var(--color-accent)' }} aria-hidden="true">
        <path d="M12 15V4m0 0L8 8m4-4l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 14v5h14v-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
        {guidance.title}
        <div className="text-muted reading-supporting">
          {guidance.body}
        </div>
      </div>
      {guidance.nativeActionLabel && (
        <button className="btn btn-ghost" style={{ fontSize: 12 }} type="button" onClick={() => void installNative()}>
          {guidance.nativeActionLabel}
        </button>
      )}
      <button className="btn btn-ghost" style={{ fontSize: 12 }} type="button" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
