/**
 * "Install Campfire on this device" hint — design/claude-design/Campfire.dc.html ~L427-433
 * (installCard). Visibility is client-side only (issue #799): suppressed in
 * standalone/iOS standalone, dismissed via localStorage when available, and
 * shown on narrow viewports with either a native install prompt or
 * platform-specific guidance. See `installHintState.ts` for the pure model.
 */
import { useEffect, useState } from 'react';
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

/** Chromium's deferred install event — not in every lib.dom version we target. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

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
  const [nativePrompt, setNativePrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [platform] = useState<InstallPlatform>(() =>
    typeof window !== 'undefined' ? readPlatform() : 'desktop',
  );

  // Reevaluate when viewport, display-mode, or install lifecycle changes.
  useEffect(() => {
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

    const onBeforeInstallPrompt = (event: Event) => {
      // Hold the deferred prompt so the Install CTA can call it — do not let
      // the browser show its own mini-infobar in parallel with our banner.
      event.preventDefault();
      setNativePrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setNativePrompt(null);
      setIsStandalone(true);
    };

    syncViewport();
    syncStandalone();
    mobileMql.addEventListener('change', syncViewport);
    standaloneMql.addEventListener('change', syncStandalone);
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      mobileMql.removeEventListener('change', syncViewport);
      standaloneMql.removeEventListener('change', syncStandalone);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
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
    setNativePrompt(null);
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === 'accepted') {
        // appinstalled listener also flips standalone; set eagerly for snappy UI.
        setIsStandalone(true);
      }
    } catch {
      // Prompt can fail if the browser already consumed it; fall back to guidance
      // on the next render by leaving nativePrompt null (manual copy still works
      // if status stays installable — re-listen will restore a fresh event).
    }
  }

  return (
    <div
      role="region"
      aria-label={guidance.title}
      data-install-hint={status}
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
