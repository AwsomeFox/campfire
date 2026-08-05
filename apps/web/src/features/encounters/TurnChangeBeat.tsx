import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setDocumentTitlePrefix } from '../../app/routeFocus';
import { prefersReducedMotion } from '../../lib/prefersReducedMotion';
import type { TurnBeatKind } from './turnBeat';

export type TurnChangeBeatEvent = {
  key: number;
  combatantId: number | null;
  pending?: boolean;
  kind: TurnBeatKind;
  tickerKind: 'turn' | 'round-wrap';
  name: string;
  round: number | null;
  identityBackground: string;
};

type Props = {
  beat: TurnChangeBeatEvent | null;
  isYourTurn: boolean;
};

/**
 * Visible-only turn feedback. The existing app-root Announcer remains the one
 * and only screen-reader channel for turn starts.
 */
export function TurnChangeBeat({ beat, isYourTurn }: Props) {
  const { t } = useTranslation();
  const [showTakeover, setShowTakeover] = useState(false);
  const [showTicker, setShowTicker] = useState(false);
  const reducedMotion = prefersReducedMotion();

  useEffect(() => {
    if (!beat) {
      setShowTakeover(false);
      setShowTicker(false);
      return;
    }
    // The SSE edge can arrive before this viewer's authorized roster refetch.
    // Retain it for hydration, but never render a nameless turn announcement.
    if (beat.pending) {
      setShowTakeover(false);
      setShowTicker(false);
      return;
    }
    // A new frame supersedes any transient UI from the previous one. In
    // particular, cleanup of the previous owned timer must not strand a
    // takeover after the turn has advanced.
    setShowTakeover(false);
    setShowTicker(true);
    const tickerTimer = window.setTimeout(
      () => setShowTicker(false),
      beat.tickerKind === 'round-wrap' ? 2_200 : 1_600,
    );

    if (beat.kind !== 'your-turn') {
      setShowTakeover(false);
      return () => window.clearTimeout(tickerTimer);
    }
    setShowTakeover(true);
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([100, 50, 100]);
    }
    const takeoverTimer = window.setTimeout(() => setShowTakeover(false), 2_500);
    const dismiss = () => setShowTakeover(false);
    window.addEventListener('pointerdown', dismiss, { once: true });
    window.addEventListener('keydown', dismiss, { once: true });
    return () => {
      window.clearTimeout(tickerTimer);
      window.clearTimeout(takeoverTimer);
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('keydown', dismiss);
    };
  }, [beat]);

  // RouteChangeFocus rebuilds titles after navigation. Its formatter observes
  // this shared prefix, while this hook owns the visibility lifecycle.
  useEffect(() => {
    const syncTitle = () => {
      setDocumentTitlePrefix(
        isYourTurn && document.visibilityState === 'hidden'
          ? t('encounters.turnBeat.titlePrefix')
          : null,
      );
    };
    syncTitle();
    document.addEventListener('visibilitychange', syncTitle);
    return () => {
      document.removeEventListener('visibilitychange', syncTitle);
      setDocumentTitlePrefix(null);
    };
  }, [isYourTurn, t]);

  if (!showTakeover && !showTicker) return null;

  const tickerLabel =
    beat?.tickerKind === 'round-wrap'
      ? t('encounters.turnBeat.round', { round: beat.round })
      : t('encounters.turnBeat.ticker', { name: beat?.name ?? '' });

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3">
      {showTakeover && beat && (
        <div
          data-testid="turn-takeover"
          className={`cf-turn-takeover ${reducedMotion ? '' : 'cf-turn-beat-motion'} w-full max-w-2xl rounded-lg border border-accent px-5 py-4 text-center shadow-2xl`}
          style={{ background: beat.identityBackground }}
        >
          <strong className="text-xl tracking-wide text-white">
            {t('encounters.turnBeat.takeover', { name: beat.name })}
          </strong>
        </div>
      )}
      {showTicker && beat && (
        <div
          data-testid="turn-ticker"
          className={`cf-turn-ticker ${reducedMotion ? '' : 'cf-turn-beat-motion'} rounded-full border border-neutral-600 bg-neutral-900 px-4 py-2 text-sm font-semibold text-white shadow-lg`}
        >
          {tickerLabel}
        </div>
      )}
    </div>
  );
}
