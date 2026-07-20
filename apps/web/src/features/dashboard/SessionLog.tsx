import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ScheduledSessionWithRsvps, Session } from '@campfire/schema';
import { api, API } from '../../lib/api';
import { EmptyState } from '../../components/ui';

/** First non-empty line of a markdown recap, with basic markdown syntax stripped for preview. */
function firstLinePlain(markdown: string): string {
  const line = markdown.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`>#-]/g, '')
    .trim();
}

export function SessionLog({ campaignId, sessions }: { campaignId: number; sessions: Session[] }) {
  const sorted = [...sessions].sort((a, b) => b.number - a.number);
  const latest3 = sorted.slice(0, 3);

  // Next scheduled session (issue #13) — fetched here (not part of the campaign
  // summary) and rendered as a banner row; failures just hide the banner.
  const [next, setNext] = useState<ScheduledSessionWithRsvps | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .get<ScheduledSessionWithRsvps | null>(`${API}/campaigns/${campaignId}/schedule/next`)
      .then((n) => {
        if (!cancelled) setNext(n);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  return (
    <div className="card elev-sm">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className="card-kicker">Session log</span>
        <div style={{ flex: 1 }} />
        <Link to={`/c/${campaignId}/sessions`} className="btn btn-ghost" style={{ fontSize: 12 }}>
          All sessions →
        </Link>
      </div>
      {next && (
        <Link
          to={`/c/${campaignId}/sessions?tab=schedule`}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            textDecoration: 'none',
            padding: '8px 12px',
            marginBottom: 8,
            borderRadius: 8,
            background: 'var(--color-accent-900, rgba(145,132,217,0.12))',
            color: 'var(--color-text)',
          }}
        >
          <span style={{ fontSize: 12, color: 'var(--color-accent)', flex: 'none' }}>📅 Next session</span>
          <span style={{ fontSize: 13 }}>
            {new Date(next.scheduledAt).toLocaleString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
          <span className="text-muted" style={{ fontSize: 11, marginLeft: 'auto', flex: 'none' }}>
            RSVP →
          </span>
        </Link>
      )}
      {latest3.length === 0 ? (
        <EmptyState icon="📓" title="No sessions logged yet" />
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
            <span style={{ fontSize: 14 }}>{s.title || firstLinePlain(s.recap) || 'No recap yet.'}</span>
            <span className="text-muted" style={{ fontSize: 11, marginLeft: 'auto', flex: 'none' }}>
              {s.playedAt ? new Date(s.playedAt).toLocaleDateString() : ''}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}
