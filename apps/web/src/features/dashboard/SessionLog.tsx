import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ScheduledSessionWithRsvps, SessionListItem } from '@campfire/schema';
import { useAuth } from '../../app/auth';
import { dashboardRsvpCue, findViewerRsvp, viewerRsvpIds } from '../../lib/dashboardRsvp';
import { formatDate, formatDateTime, useFormattingLocale } from '../../lib/format';
import { EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';

/** Strip basic markdown syntax from a recap excerpt for a one-line preview. */
function firstLinePlain(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`>#-]/g, '')
    .trim();
}

export function SessionLog({
  campaignId,
  sessions,
  nextSession,
  scheduleSync,
}: {
  campaignId: number;
  sessions: SessionListItem[];
  nextSession: ScheduledSessionWithRsvps | null;
  scheduleSync: 'live' | 'stale' | 'offline';
}) {
  useFormattingLocale();
  const { me } = useAuth();
  const myIds = useMemo(() => viewerRsvpIds(me?.user ?? null), [me]);
  const mine = nextSession ? findViewerRsvp(nextSession.rsvps, myIds) : undefined;
  const rsvpCue = dashboardRsvpCue(mine?.status);

  const sorted = [...sessions].sort((a, b) => b.number - a.number);
  const latest3 = sorted.slice(0, 3);

  const syncMessage = scheduleSync === 'offline'
    ? 'Offline — showing last-known next-session details.'
    : scheduleSync === 'stale'
      ? 'Live updates interrupted — showing last-known next-session details.'
      : null;

  return (
    <section className="card elev-sm dashboard-session-log" aria-labelledby="dashboard-session-log-title">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h2 id="dashboard-session-log-title" className="card-kicker">Session log</h2>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/sessions`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          All sessions →
        </Link>
      </div>
      {syncMessage && (
        <p
          role="status"
          aria-live="polite"
          className={scheduleSync === 'offline' ? 'cf-chip cf-chip-offline' : 'cf-chip cf-chip-neutral'}
          style={{ display: 'block', width: 'fit-content', maxWidth: '100%', margin: '8px 0', whiteSpace: 'normal' }}
        >
          {syncMessage}
        </p>
      )}
      {nextSession && (
        <Link
          to={`/c/${campaignId}/sessions?tab=schedule`}
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            gap: '3px 12px',
            alignItems: 'center',
            textDecoration: 'none',
            padding: '8px 12px',
            minHeight: 48,
            marginBottom: 8,
            borderRadius: 8,
            background: 'var(--color-accent-900, rgba(145,132,217,0.12))',
            color: 'var(--color-text)',
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--color-accent-2-300)' }}>
              <GameIcon slug="calendar" size={12} className="inline align-text-bottom mr-1" />Next session
            </span>
            <span style={{ display: 'block', fontSize: 13 }}>
              {formatDateTime(nextSession.scheduledAt, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
            {nextSession.title && (
              <span className="text-muted" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
                {nextSession.title}
              </span>
            )}
          </span>
          {/*
            Issue #785: surface the viewer's saved RSVP. Only unanswered keeps
            the urgent "RSVP needed →" cue; answered states show the status plus
            a quieter Change RSVP affordance.
          */}
          <span
            data-testid="dashboard-rsvp-cue"
            data-rsvp-unanswered={rsvpCue.unanswered ? 'true' : 'false'}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 2,
              marginLeft: 'auto',
              flex: 'none',
              textAlign: 'right',
              fontSize: 'var(--type-meta)',
            }}
          >
            <span
              className={rsvpCue.unanswered ? undefined : 'text-muted'}
              style={{
                color: rsvpCue.unanswered ? 'var(--color-accent-2-300)' : undefined,
                fontWeight: rsvpCue.unanswered ? 600 : 400,
              }}
            >
              {rsvpCue.statusLabel}
              {rsvpCue.unanswered ? ' →' : ''}
            </span>
            {rsvpCue.changeLabel && (
              <span className="text-muted" style={{ fontSize: 11 }}>
                {rsvpCue.changeLabel} →
              </span>
            )}
          </span>
        </Link>
      )}
      {latest3.length === 0 ? (
        <EmptyState icon="book-cover" title="No sessions logged yet" />
      ) : (
        latest3.map((s) => (
          <Link
            key={s.id}
            to={`/c/${campaignId}/sessions`}
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'baseline',
              color: 'var(--color-text)',
              textDecoration: 'none',
              cursor: 'pointer',
              padding: '8px 0',
              borderLeft: '2px solid var(--color-accent-800)',
              paddingLeft: 12,
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--color-accent)', flex: 'none' }}>S{s.number}</span>
            <span style={{ fontSize: 14 }}>{s.title || firstLinePlain(s.recapExcerpt) || 'No recap yet.'}</span>
            <span className="text-muted" style={{ fontSize: 'var(--type-meta)', marginLeft: 'auto', flex: 'none' }}>
              {s.playedAt ? formatDate(s.playedAt) : ''}
            </span>
          </Link>
        ))
      )}
    </section>
  );
}
