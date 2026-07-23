/**
 * Single recovery surface for cold-load bootstrap failures (issue #801).
 *
 * Shown when GET /auth/status and/or GET /me cannot be classified yet — Retry
 * re-runs both promises. Shared by AuthedLayout, LoginPage, and SetupPage so
 * partial failures never pick setup vs login from an unknown status.
 */
import { GameIcon } from '../components/GameIcon';

export function BootstrapRecoveryScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card elev-sm text-center space-y-2" style={{ maxWidth: 380 }}>
        <p className="flex justify-center text-[var(--color-neutral-400)]"><GameIcon slug="campfire" size={28} /></p>
        <p className="font-bold text-white">Can&apos;t reach the server</p>
        <p className="text-sm text-slate-400">Check your connection and try again.</p>
        <button type="button" className="btn btn-primary" style={{ marginTop: 4 }} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
