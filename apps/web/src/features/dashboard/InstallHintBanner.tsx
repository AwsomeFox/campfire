/**
 * "Install Campfire on this device" hint — design/claude-design/Campfire.dc.html ~L427-433
 * (installCard). No backing API: visibility is purely client-side — shown on small/mobile
 * viewports, dismissed permanently via localStorage. Not shown at all on desktop widths.
 *
 * States: unsupported | installable | installed | dismissed
 * - unsupported: not mobile or no install capability detected
 * - installable: mobile viewport + not standalone + not dismissed
 * - installed: running in standalone/display-mode standalone or iOS standalone
 * - dismissed: user explicitly dismissed the banner
 *
 * Re-evaluates on display-mode change (e.g. after installation).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const DISMISS_KEY = 'campfire.installHintDismissed';
const MOBILE_QUERY = '(max-width: 768px)';
const STANDALONE_QUERY = '(display-mode: standalone)';

type InstallState = 'unsupported' | 'installable' | 'installed' | 'dismissed';

/**
 * Detect if the app is running in standalone (installed PWA) mode.
 * Checks both the standard display-mode media query and iOS navigator.standalone.
 */
function getIsStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mqStandalone = window.matchMedia(STANDALONE_QUERY).matches;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const iosStandalone = (navigator as any).standalone === true;
  return mqStandalone || iosStandalone;
}

export function InstallHintBanner() {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false,
  );

  const [isStandalone, setIsStandalone] = useState(getIsStandalone);

  // Store the beforeinstallprompt event so we can trigger it natively on click
  const deferredPromptRef = useRef<Event | null>(null);
  const [hasNativePrompt, setHasNativePrompt] = useState(false);

  // Listen for viewport (mobile) changes
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Listen for display-mode changes (e.g. user installs the PWA while it's open)
  useEffect(() => {
    const mql = window.matchMedia(STANDALONE_QUERY);
    const onChange = () => setIsStandalone(getIsStandalone());
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Capture the beforeinstallprompt event for native install flow
  useEffect(() => {
    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      deferredPromptRef.current = e;
      setHasNativePrompt(true);
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  // Listen for appinstalled to transition to installed state
  useEffect(() => {
    function onAppInstalled() {
      setIsStandalone(true);
      deferredPromptRef.current = null;
      setHasNativePrompt(false);
    }

    window.addEventListener('appinstalled', onAppInstalled);
    return () => window.removeEventListener('appinstalled', onAppInstalled);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // best-effort only — storage may be unavailable
    }
  }, []);

  const handleInstallClick = useCallback(async () => {
    if (deferredPromptRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prompt = deferredPromptRef.current as any;
      prompt.prompt();
      const result = await prompt.userChoice;
      if (result?.outcome === 'accepted') {
        setIsStandalone(true);
      }
      deferredPromptRef.current = null;
      setHasNativePrompt(false);
    }
  }, []);

  // Derive current state
  const state: InstallState = (() => {
    if (isStandalone) return 'installed';
    if (dismissed) return 'dismissed';
    if (!isMobile) return 'unsupported';
    return 'installable';
  })();

  // Only render banner in the installable state
  if (state !== 'installable') return null;

  return (
    <div
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
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flex: 'none', color: 'var(--color-accent)' }}>
        <path d="M12 15V4m0 0L8 8m4-4l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 14v5h14v-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
        Install Campfire on this device
        <div className="text-muted reading-supporting">
          {hasNativePrompt
            ? 'Tap "Install" to add Campfire to your home screen.'
            : 'Browser menu \u2192 Add to Home Screen. Works offline between sessions.'}
        </div>
      </div>
      {hasNativePrompt && (
        <button className="btn btn-sm" style={{ fontSize: 12 }} onClick={handleInstallClick}>
          Install
        </button>
      )}
      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
