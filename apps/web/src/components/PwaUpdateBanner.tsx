/**
 * Non-blocking PWA Update Banner & SW Failure Recovery UI (issue #515).
 *
 * Displays:
 * 1) "Update ready" notification banner with "Reload now" and "After session".
 * 2) In-flight action guard warning if user attempts to reload while encounter
 *    actions, form submissions, or pending mutations are active.
 * 3) SW registration/update error banner with "Clear cache & reload" recovery.
 */

import { useEffect, useState } from 'react';
import {
  clearCacheAndReload,
  clearPwaUpdateError,
  dismissUpdate,
  getPwaState,
  subscribePwaState,
  triggerUpdateNow,
  type PwaUpdateState,
} from '../lib/pwaUpdate';
import { subscribeReloadGuard } from '../lib/reloadGuard';
import { Btn } from './ui';

export function PwaUpdateBanner() {
  const [pwaState, setPwaState] = useState<PwaUpdateState>(getPwaState());
  const [, setGuardTick] = useState(0);

  useEffect(() => {
    const unsubPwa = subscribePwaState(setPwaState);
    const unsubGuard = subscribeReloadGuard(() => setGuardTick((t) => t + 1));
    return () => {
      unsubPwa();
      unsubGuard();
    };
  }, []);

  const showUpdateBanner = pwaState.needRefresh && !pwaState.deferred;
  const showErrorBanner = Boolean(pwaState.updateError);

  if (!showUpdateBanner && !showErrorBanner) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      role="region"
      aria-label="Application updates"
      className="fixed bottom-4 right-4 z-50 max-w-md w-full px-4 pointer-events-none"
    >
      {showUpdateBanner && (
        <div
          id="pwa-update-banner"
          data-testid="pwa-update-banner"
          className="pointer-events-auto bg-slate-900/95 border border-purple-500/40 text-slate-100 p-4 rounded-xl shadow-2xl backdrop-blur-md space-y-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-semibold text-purple-400 uppercase tracking-wider">
                Update Ready
              </p>
              <p className="text-sm font-medium text-white">
                A new version of Campfire is ready to install.
              </p>
            </div>
          </div>

          {pwaState.blockedByGuard && (
            <p
              data-testid="pwa-blocked-warning"
              className="text-xs text-amber-400 bg-amber-950/40 p-2 rounded border border-amber-800/50"
            >
              Action or form submission in progress. Reload when complete.
            </p>
          )}

          <div className="flex items-center gap-2 pt-1 pointer-events-auto">
            <Btn
              id="pwa-reload-now"
              data-testid="pwa-reload-now"
              className="text-xs px-3 py-1.5 font-semibold bg-purple-600 hover:bg-purple-500 text-white rounded"
              onClick={() => void triggerUpdateNow()}
            >
              Reload now
            </Btn>
            <Btn
              id="pwa-dismiss"
              data-testid="pwa-dismiss"
              ghost
              className="text-xs px-3 py-1.5"
              onClick={dismissUpdate}
            >
              After session
            </Btn>
          </div>
        </div>
      )}

      {showErrorBanner && (
        <div
          id="pwa-update-error"
          data-testid="pwa-update-error"
          className="pointer-events-auto bg-rose-950/95 border border-rose-700/60 text-slate-100 p-4 rounded-xl shadow-2xl backdrop-blur-md space-y-3"
        >
          <div className="space-y-1">
            <p className="text-xs font-semibold text-rose-400 uppercase tracking-wider">
              Update Error
            </p>
            <p className="text-sm text-slate-200">
              Service worker registration or update failed.
            </p>
            {pwaState.updateError && (
              <p className="text-xs text-rose-300 font-mono truncate">{pwaState.updateError}</p>
            )}
          </div>

          {pwaState.blockedByGuard && (
            <p
              data-testid="pwa-error-blocked-warning"
              className="text-xs text-amber-400 bg-amber-950/40 p-2 rounded border border-amber-800/50"
            >
              Action or form submission in progress. Reload when complete.
            </p>
          )}

          <div className="flex items-center gap-2 pt-1 pointer-events-auto">
            <Btn
              id="pwa-clear-cache-reload"
              data-testid="pwa-clear-cache-reload"
              danger
              className="text-xs px-3 py-1.5 font-semibold"
              onClick={() => void clearCacheAndReload()}
            >
              Clear cache & reload
            </Btn>
            <Btn
              id="pwa-error-dismiss"
              data-testid="pwa-error-dismiss"
              ghost
              className="text-xs px-3 py-1.5"
              onClick={clearPwaUpdateError}
            >
              Dismiss
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
