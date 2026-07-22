/**
 * "Install Campfire on this device" hint — design/claude-design/Campfire.dc.html ~L427-433
 * (installCard). No backing API: visibility is purely client-side — shown on small/mobile
 * viewports, dismissed permanently via localStorage. Not shown at all on desktop widths.
 */
import { useEffect, useState } from 'react';

const DISMISS_KEY = 'campfire.installHintDismissed';
const MOBILE_QUERY = '(max-width: 768px)';

export function InstallHintBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  if (dismissed || !isMobile) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // best-effort only
    }
  }

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
          Browser menu → Add to Home Screen. Works offline between sessions.
        </div>
      </div>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
