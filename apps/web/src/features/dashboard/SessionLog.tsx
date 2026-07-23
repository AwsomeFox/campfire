import { Link } from 'react-router-dom';
import type { Role, ScheduledSessionWithRsvps, SessionListItem } from '@campfire/schema';
import { isScheduleInProgress } from '@campfire/schema';
import { formatDate, formatDateTime, useFormattingLocale } from '../../lib/format';
import { EmptyState } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { Markdown } from '../../components/Markdown';

/** Strip basic markdown syntax from a recap excerpt for a one-line preview. */
function firstLinePlain(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line
    .replace(/^#+\s*/, '')
    .replace(/[*_`>#-]/g, '')
    .trim();
}

function rsvpSummary(rsvps: ScheduledSessionWithRsvps['rsvps']): string | null {
  if (rsvps.length === 0) return null;
  let yes = 0;
  let maybe = 0;
  let no = 0;
  for (const r of rsvps) {
    if (r.status === 'yes') yes += 1;
    else if (r.status === 'maybe') maybe += 1;
    else if (r.status === 'no') no += 1;
  }
  const parts: string[] = [];
  if (yes) parts.push(`${yes} in`);
  if (maybe) parts.push(`${maybe} maybe`);
  if (no) parts.push(`${no} out`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function ScheduleCard({
  campaignId,
  schedule,
  happeningNow,
  role,
}: {
  campaignId: number;
  schedule: ScheduledSessionWithRsvps;
  happeningNow: boolean;
  role: Role | null;
}) {
  const roster = rsvpSummary(schedule.rsvps);
  const canOpenEncounters = role === 'dm' || role === 'player' || role === 'viewer';
  const showDmTools = role === 'dm';

  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: '10px 12px',
        minHeight: 48,
        marginBottom: 8,
        borderRadius: 8,
        background: happeningNow
          ? 'var(--color-accent-800, rgba(145,132,217,0.22))'
          : 'var(--color-accent-900, rgba(145,132,217,0.12))',
        color: 'var(--color-text)',
        border: happeningNow ? '1px solid var(--color-accent, #9184d9)' : '1px solid transparent',
      }}
    >
      <Link
        to={`/c/${campaignId}/sessions?tab=schedule`}
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: '3px 12px',
          alignItems: 'center',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: 'block',
              fontSize: happeningNow ? 13 : 12,
              fontWeight: happeningNow ? 700 : 400,
              color: happeningNow ? 'var(--color-accent-2-200, #f0e9ff)' : 'var(--color-accent-2-300)',
            }}
          >
            <GameIcon slug="calendar" size={12} className="inline align-text-bottom mr-1" />
            {happeningNow ? 'Happening now' : 'Next session'}
          </span>
          <span style={{ display: 'block', fontSize: happeningNow ? 14 : 13, fontWeight: happeningNow ? 600 : 400 }}>
            {formatDateTime(schedule.scheduledAt, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
            <span className="text-muted" style={{ fontWeight: 400 }}>
              {' '}
              · {formatDuration(schedule.durationMinutes)}
            </span>
          </span>
          {schedule.title && (
            <span className="text-muted" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
              {schedule.title}
            </span>
          )}
          {schedule.location && (
            <span className="text-muted" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
              <GameIcon slug="position-marker" size={11} className="inline align-text-bottom mr-1" />
              {schedule.location}
            </span>
          )}
          {roster && (
            <span className="text-muted" style={{ display: 'block', fontSize: 12 }}>
              RSVP: {roster}
            </span>
          )}
        </span>
        <span className="text-muted" style={{ fontSize: 'var(--type-meta)', marginLeft: 'auto', flex: 'none' }}>
          {happeningNow ? 'Schedule →' : 'RSVP →'}
        </span>
      </Link>
      {happeningNow && schedule.notes && (
        <Markdown className="!text-xs !text-[color:var(--color-text)] !m-0">{schedule.notes}</Markdown>
      )}
      {happeningNow && canOpenEncounters && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {showDmTools && (
            <Link to={`/c/${campaignId}/encounters`} className="btn btn-ghost" style={{ fontSize: 12, minHeight: 36 }}>
              Encounters
            </Link>
          )}
          <Link to={`/c/${campaignId}/screen`} className="btn btn-ghost" style={{ fontSize: 12, minHeight: 36 }}>
            Player display
          </Link>
          <Link to={`/c/${campaignId}/notes`} className="btn btn-ghost" style={{ fontSize: 12, minHeight: 36 }}>
            Session notes
          </Link>
        </div>
      )}
    </div>
  );
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

export function SessionLog({
  campaignId,
  sessions,
  inProgressSession,
  nextSession,
  scheduleSync,
  role,
}: {
  campaignId: number;
  sessions: SessionListItem[];
  inProgressSession: ScheduledSessionWithRsvps | null;
  nextSession: ScheduledSessionWithRsvps | null;
  scheduleSync: 'live' | 'stale' | 'offline';
  role: Role | null;
}) {
  useFormattingLocale();
  const sorted = [...sessions].sort((a, b) => b.number - a.number);
  const latest3 = sorted.slice(0, 3);

  const syncMessage = scheduleSync === 'offline'
    ? 'Offline — showing last-known next-session details.'
    : scheduleSync === 'stale'
      ? 'Live updates interrupted — showing last-known next-session details.'
      : null;

  // Prefer the summary's in-progress projection; fall back to classifying nextSession
  // so older cached payloads still surface "Happening now" during the duration window.
  const happening =
    inProgressSession
    ?? (nextSession && isScheduleInProgress(nextSession.scheduledAt, nextSession.durationMinutes)
      ? nextSession
      : null);
  const upcoming =
    nextSession && (!happening || nextSession.id !== happening.id) ? nextSession : null;

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
      {happening && (
        <ScheduleCard campaignId={campaignId} schedule={happening} happeningNow role={role} />
      )}
      {upcoming && (
        <ScheduleCard campaignId={campaignId} schedule={upcoming} happeningNow={false} role={role} />
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
