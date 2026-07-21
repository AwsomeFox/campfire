/**
 * Session scheduling (issue #13) — the "Schedule" tab of SessionsPage.
 * Planned game nights with per-member availability (RSVP yes/maybe/no) and the
 * campaign's ICS calendar feed (subscribe URL for Google/Apple/Outlook).
 * DM: schedule/edit/cancel sessions, enable/rotate/disable the feed.
 * Everyone: see what's coming, one-tap RSVP.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CalendarFeed, RsvpStatus, ScheduledSessionWithRsvps, SessionRsvp } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GameIcon } from '../../components/GameIcon';

const RSVP_OPTIONS: Array<{ status: RsvpStatus; label: string; icon: string }> = [
  { status: 'yes', label: 'In', icon: '✓' },
  { status: 'maybe', label: 'Maybe', icon: '?' },
  { status: 'no', label: 'Out', icon: '✗' },
];

export function SchedulePanel({ campaignId, isDm }: { campaignId: number; isDm: boolean }) {
  const { me } = useAuth();
  const [schedules, setSchedules] = useState<ScheduledSessionWithRsvps[]>([]);
  const [feed, setFeed] = useState<CalendarFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // RSVP rows store the server-side user id: String(users.id) for real users,
  // `dev:<name>` on the DEV_AUTH header path. Match either.
  const myIds = useMemo(() => {
    if (!me) return new Set<string>();
    return new Set([String(me.user.id), `dev:${me.user.username}`]);
  }, [me]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, feedInfo] = await Promise.all([
        api.get<ScheduledSessionWithRsvps[]>(`${API}/campaigns/${campaignId}/schedule`),
        api.get<CalendarFeed>(`${API}/campaigns/${campaignId}/calendar-feed`),
      ]);
      setSchedules(list);
      setFeed(feedInfo);
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 401 || e.status === 403))) {
        setError("Couldn't load the schedule.");
      }
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const upcoming = schedules.filter((s) => Date.parse(s.scheduledAt) >= now);
  const past = schedules.filter((s) => Date.parse(s.scheduledAt) < now).reverse(); // most recent first
  const [next, ...later] = upcoming;

  if (loading) {
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  }

  return (
    <div className="space-y-4" style={{ maxWidth: 720 }}>
      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="flex items-center gap-2.5">
        <h2 className="text-sm font-bold text-white m-0">Next session</h2>
        <div className="flex-1" />
        {isDm && !showAddForm && (
          <Btn className="!min-h-0 !py-1.5 text-xs" onClick={() => setShowAddForm(true)}>
            + Schedule session
          </Btn>
        )}
      </div>

      {isDm && showAddForm && (
        <ScheduleForm
          onSubmit={async (body) => {
            await api.post<ScheduledSessionWithRsvps>(`${API}/campaigns/${campaignId}/schedule`, body);
            setShowAddForm(false);
            void load();
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}

      {!next && !showAddForm && (
        <Card>
          <EmptyState
            icon="calendar"
            title="No session on the calendar"
            hint={isDm ? 'Use “+ Schedule session” to pick the next game night.' : 'Your DM hasn’t scheduled the next session yet.'}
          />
        </Card>
      )}

      {next && <ScheduleItem schedule={next} hero isDm={isDm} myIds={myIds} onChange={load} />}

      {later.length > 0 && (
        <>
          <h2 className="text-sm font-bold text-white m-0">Later</h2>
          {later.map((s) => (
            <ScheduleItem key={s.id} schedule={s} isDm={isDm} myIds={myIds} onChange={load} />
          ))}
        </>
      )}

      <FeedCard campaignId={campaignId} isDm={isDm} feed={feed} onChange={load} />

      {past.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-bold text-white m-0">Past</h2>
          {past.map((s) => (
            <p key={s.id} className="text-muted text-xs m-0">
              {formatWhen(s.scheduledAt)}
              {s.title ? ` — ${s.title}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ScheduleItem({
  schedule,
  hero = false,
  isDm,
  myIds,
  onChange,
}: {
  schedule: ScheduledSessionWithRsvps;
  hero?: boolean;
  isDm: boolean;
  myIds: Set<string>;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = schedule.rsvps.find((r) => myIds.has(r.userId));

  async function setRsvp(status: RsvpStatus) {
    setBusy(true);
    setError(null);
    try {
      await api.put<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}/rsvp`, { status });
      onChange();
    } catch {
      setError("Couldn't save your RSVP.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${API}/schedule/${schedule.id}`);
      onChange();
    } catch {
      setError("Couldn't cancel the session.");
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <ScheduleForm
        initial={schedule}
        onSubmit={async (body) => {
          await api.patch<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}`, body);
          setEditing(false);
          onChange();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <Card className={hero ? '!border-[var(--color-accent-800)]' : ''}>
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}
        <div className="flex items-baseline gap-2.5 flex-wrap">
          <span className={hero ? 'text-lg font-extrabold text-white' : 'text-sm font-bold text-white'}>
            {formatWhen(schedule.scheduledAt)}
          </span>
          {schedule.title && <span className="text-muted text-sm">{schedule.title}</span>}
          <span className="text-muted text-xs ml-auto">{formatDuration(schedule.durationMinutes)}</span>
        </div>
        {schedule.location && <p className="flex items-center gap-1 text-muted text-xs m-0"><GameIcon slug="position-marker" size={11} /> {schedule.location}</p>}
        {schedule.notes && <p className="text-sm m-0" style={{ color: 'var(--color-text)' }}>{schedule.notes}</p>}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Can you make it?</span>
          {RSVP_OPTIONS.map((opt) => (
            <Btn
              key={opt.status}
              ghost={mine?.status !== opt.status}
              className="!min-h-0 !py-1 !px-2.5 text-xs"
              disabled={busy}
              onClick={() => setRsvp(opt.status)}
            >
              {opt.icon} {opt.label}
            </Btn>
          ))}
        </div>

        {schedule.rsvps.length > 0 && <RsvpList rsvps={schedule.rsvps} />}

        {isDm && (
          <div className="flex gap-2">
            <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={() => setEditing(true)}>
              Edit
            </Btn>
            <Btn danger ghost className="!min-h-0 !py-1 text-xs" onClick={() => setConfirmingCancel(true)} disabled={busy}>
              Cancel session
            </Btn>
          </div>
        )}
      </div>

      {confirmingCancel && (
        <ConfirmDialog
          title="Cancel this session?"
          body="The scheduled session and everyone's RSVPs will be removed."
          confirmLabel={busy ? 'Cancelling…' : 'Cancel session'}
          busy={busy}
          onConfirm={cancel}
          onCancel={() => setConfirmingCancel(false)}
        />
      )}
    </Card>
  );
}

function RsvpList({ rsvps }: { rsvps: SessionRsvp[] }) {
  const groups: Array<{ status: RsvpStatus; label: string }> = [
    { status: 'yes', label: 'In' },
    { status: 'maybe', label: 'Maybe' },
    { status: 'no', label: 'Out' },
  ];
  return (
    <div className="space-y-0.5">
      {groups.map(({ status, label }) => {
        const members = rsvps.filter((r) => r.status === status);
        if (members.length === 0) return null;
        return (
          <p key={status} className="text-xs m-0 text-muted">
            <span className="font-bold" style={{ color: 'var(--color-accent)' }}>
              {label}:
            </span>{' '}
            {members.map((m) => m.userName + (m.note ? ` (${m.note})` : '')).join(', ')}
          </p>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: ScheduledSessionWithRsvps;
  onSubmit: (body: { scheduledAt: string; durationMinutes: number; title: string; location: string; notes: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState(initial ? toLocalInputValue(initial.scheduledAt) : '');
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 240));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const parsed = Date.parse(when);
    const minutes = Number(duration);
    if (Number.isNaN(parsed)) {
      setError('Pick a date and time.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        scheduledAt: new Date(parsed).toISOString(),
        durationMinutes: Number.isFinite(minutes) && minutes >= 15 ? Math.min(minutes, 1440) : 240,
        title: title.trim(),
        location: location.trim(),
        notes,
      });
    } catch {
      setError("Couldn't save the session.");
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">{initial ? 'Edit scheduled session' : 'Schedule the next session'}</h2>
      {error && <ErrorNote message={error} />}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">When</label>
          <TextInput type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Duration (minutes)</label>
          <TextInput type="number" min={15} max={1440} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </div>
      </div>
      <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Title (optional), e.g. "Session 12 — the heist"' />
      <TextInput value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Where? (optional) — Sam's place, VTT link…" />
      <TextArea
        className="!min-h-[60px]"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes for the table (optional) — bring level 5 sheets, we start on time…"
      />
      <div className="flex gap-2 justify-end">
        <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : initial ? 'Save' : 'Schedule'}
        </Btn>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function FeedCard({
  campaignId,
  isDm,
  feed,
  onChange,
}: {
  campaignId: number;
  isDm: boolean;
  feed: CalendarFeed | null;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const absoluteUrl = feed?.url ? `${window.location.origin}${feed.url}` : null;

  async function rotate() {
    setBusy(true);
    setError(null);
    try {
      await api.post<CalendarFeed>(`${API}/campaigns/${campaignId}/calendar-feed`);
      onChange();
    } catch {
      setError("Couldn't update the calendar feed.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`${API}/campaigns/${campaignId}/calendar-feed`);
      onChange();
    } catch {
      setError("Couldn't disable the calendar feed.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!absoluteUrl) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the URL is still selectable */
    }
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-sm font-bold text-white"><GameIcon slug="calendar" size={16} /> Calendar feed</span>
        <div className="flex-1" />
        {isDm && absoluteUrl && (
          <>
            <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={rotate} disabled={busy} title="Generate a new URL; the old one stops working">
              Rotate
            </Btn>
            <Btn danger ghost className="!min-h-0 !py-1 text-xs" onClick={disable} disabled={busy}>
              Disable
            </Btn>
          </>
        )}
        {isDm && !absoluteUrl && (
          <Btn className="!min-h-0 !py-1 text-xs" onClick={rotate} disabled={busy}>
            Enable feed
          </Btn>
        )}
      </div>
      {error && <ErrorNote message={error} />}
      {absoluteUrl ? (
        <>
          <p className="text-muted text-xs m-0">
            Subscribe from Google / Apple / Outlook calendar — scheduled sessions show up automatically. Anyone with this URL can
            read the schedule, so treat it like a party secret.
          </p>
          <div className="flex items-center gap-2">
            <code
              className="text-[11px] px-2 py-1.5 rounded flex-1 min-w-0 overflow-x-auto whitespace-nowrap"
              style={{ background: 'var(--color-neutral-900)', color: 'var(--color-text)' }}
            >
              {absoluteUrl}
            </code>
            <Btn ghost className="!min-h-0 !py-1 text-xs shrink-0" onClick={copy}>
              {copied ? 'Copied!' : 'Copy'}
            </Btn>
          </div>
        </>
      ) : (
        <p className="text-muted text-xs m-0">
          {isDm
            ? 'Enable the feed to get a private URL the whole table can subscribe to in their calendar apps.'
            : 'Not enabled yet — ask your DM to turn on the calendar feed.'}
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Undated';
  return formatDateTime(d, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

/** ISO UTC -> value for <input type="datetime-local"> in the viewer's local time. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
