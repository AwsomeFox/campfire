/**
 * Dashboard AI-DM activity surface (#344 point 3). Reads the single app-wide stream
 * snapshot (mounted in app/Layout.tsx via `useAiDmLiveActivity`) — no stream of its
 * own. Two independent bits, both gated on the seat being in Driver mode:
 *   - a presence + "last thing it did" line, visible to every member (matches the
 *     combat tracker's chip, issue point 1/2).
 *   - a dismissible "the AI drafted something for review" nudge, DM-only, shown the
 *     moment a `tool` event with `proposed: true` lands — the same signal that bumps
 *     the sidebar's pending-proposals badge in Layout.tsx.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAiDmLiveActivity } from './useAiDmLiveActivity';
import { AiDmPresenceTag, AiDmToolActivityRow } from './AiDmActivityChip';
import { resolveToolActivity } from './toolActivity';
import { GameIcon } from '../../components/GameIcon';

export function AiDmDashboardActivity({ campaignId, isDm }: { campaignId: number; isDm: boolean }) {
  const liveActivity = useAiDmLiveActivity();
  // Dismiss tracks the proposal COUNT it was dismissed at, so a fresh proposal after
  // dismissing re-shows the nudge instead of hiding it forever for the session.
  const [dismissedAt, setDismissedAt] = useState(0);

  // Reset the dismissal if the campaign in view changes (context is app-wide, but a DM
  // could still switch campaigns without unmounting Layout in an odd nested-route case).
  useEffect(() => {
    setDismissedAt(0);
  }, [campaignId]);

  if (liveActivity.mode !== 'driver') return null;

  const showProposalNudge = isDm && liveActivity.proposalFiledCount > dismissedAt;
  const chip = liveActivity.lastToolEvent
    ? resolveToolActivity(liveActivity.lastToolEvent, { campaignId })
    : null;

  return (
    <div className="card elev-sm" style={{ padding: 12, gap: 8 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <AiDmPresenceTag turnActive={liveActivity.turnActive} />
        {chip && liveActivity.lastToolAt !== null && <AiDmToolActivityRow chip={chip} at={liveActivity.lastToolAt} />}
      </div>
      {showProposalNudge && (
        <div
          className="flex items-center gap-2 flex-wrap"
          style={{
            fontSize: 12.5,
            padding: '6px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
          }}
        >
          <span className="flex-1 min-w-0"><GameIcon slug="quill-ink" size={12} className="inline align-text-bottom mr-1" />The AI drafted something for review.</span>
          <Link to={`/c/${campaignId}/proposals`} className="btn btn-primary" style={{ fontSize: 11.5, minHeight: 26 }}>
            Review
          </Link>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 11.5, minHeight: 26 }}
            onClick={() => setDismissedAt(liveActivity.proposalFiledCount)}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
