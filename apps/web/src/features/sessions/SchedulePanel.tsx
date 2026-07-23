/**
 * Session scheduling (issue #13) — the "Schedule" tab of SessionsPage.
 * Planned game nights with per-member availability (RSVP yes/maybe/no) and the
 * campaign's ICS calendar feed (subscribe URL for Google/Apple/Outlook).
 * DM: schedule/edit/cancel sessions, enable/rotate/disable the feed.
 * Everyone: see what's coming, one-tap RSVP.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CalendarFeed, RsvpStatus, ScheduledSessionWithRsvps, SessionRsvp } from '@campfire/schema';
import {
  endSessionDurationMinutes,
  extendSessionDurationMinutes,
  partitionSchedules,
  scheduleEndsAtMs,
} from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { usePanelData } from '../../lib/usePanelData';
import { formatDateTime, useFormattingLocale } from '../../lib/format';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import { viewerRsvpIds } from '../../lib/dashboardRsvp';
import {
  cancelledScheduleDetailCopy,
  clearCancelledScheduleDetail,
  readCancelledScheduleDetail,
} from '../../lib/scheduleNotificationCopy';

const RSVP_OPTIONS: Array<{ status: RsvpStatus; label: string; icon: string }> = [
  { status: 'yes', label: 'In', icon: '✓' },
  { status: 'maybe', label: 'Maybe', icon: '?' },
  { status: 'no', label: 'Out', icon: '✗' },
];

export function SchedulePanel({ campaignId, isDm }: { campaignId: number; isDm: boolean }) {
  const formattingLocale = useFormattingLocale();
  const { me } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [schedules, setSchedules] = useState<ScheduledSessionWithRsvps[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Issue #820: cancelled-night deep link from the notifications bell.
  const cancelledIdRaw = searchParams.get('cancelled');
  const cancelledId = cancelledIdRaw && /^\d+$/.test(cancelledIdRaw) ? Number(cancelledIdRaw) : null;
  const cancelledDetail = useMemo(
    () => (cancelledId ? readCancelledScheduleDetail(cancelledId) : null),
    [cancelledId],
  );
  const cancelledCopy = useMemo(
    () => cancelledScheduleDetailCopy(cancelledDetail, formattingLocale),
    [cancelledDetail, formattingLocale],
  );

  // RSVP rows store the server-side user id: String(users.id) for real users,
  // `dev:<name>` on the DEV_AUTH header path. Match either (shared with #785).
  const myIds = useMemo(() => viewerRsvpIds(me?.user ?? null), [me]);

  // Core content (the schedule list) loads on its own. The optional calendar-feed
  // panel loads independently below in <FeedCard> so a feed outage can never blank
  // the schedule or set this page-level error (issue #697).
  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.get<ScheduledSessionWithRsvps[]>(`${API}/campaigns/${campaignId}/schedule`);
      setSchedules(list);
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

  // Issue #818: keep a game night in the live lists until scheduledAt+duration ends.
  // Wake at the next phase boundary (soonest upcoming start or in-progress end) so
  // "Next session" ↔ "Happening now" flips without a reload.
  const [scheduleNowMs, setScheduleNowMs] = useState(() => Date.now());
  const { inProgress, upcoming, past } = useMemo(
    () => partitionSchedules(schedules, scheduleNowMs),
    [schedules, scheduleNowMs],
  );
  useEffect(() => {
    const boundaries: number[] = [];
    for (const s of inProgress) {
      const endMs = scheduleEndsAtMs(s.scheduledAt, s.durationMinutes);
      if (Number.isFinite(endMs) && endMs > scheduleNowMs) boundaries.push(endMs);
    }
    for (const s of upcoming) {
      const startMs = Date.parse(s.scheduledAt);
      if (Number.isFinite(startMs) && startMs > scheduleNowMs) boundaries.push(startMs);
    }
    if (boundaries.length === 0) return;
    const delay = Math.min(...boundaries) - scheduleNowMs + 25;
    const timer = window.setTimeout(() => setScheduleNowMs(Date.now()), Math.max(25, delay));
    return () => window.clearTimeout(timer);
  }, [inProgress, upcoming, scheduleNowMs]);
  const [next, ...later] = upcoming;
  const hasLive = inProgress.length > 0 || Boolean(next);

  if (loading) {
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  }

  function dismissCancelledDetail() {
    if (cancelledId != null) clearCancelledScheduleDetail(cancelledId);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('cancelled');
    setSearchParams(nextParams, { replace: true });
  }

  return (
    <div className="space-y-4" style={{ maxWidth: 720 }}>
      {error && <ErrorNote message={error} onRetry={load} />}

      {cancelledId != null && (
        <Card
          id={`cancelled-schedule-${cancelledId}`}
          data-entity-type="cancelled_schedule"
          data-entity-id={cancelledId}
        >
          <div className="flex items-start gap-2.5">
            <span className="flex leading-none pt-0.5 text-[var(--color-neutral-400)]">
              <GameIcon slug="calendar" size={18} />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-semibold m-0" style={{ fontFamily: 'var(--font-heading)' }}>
                {cancelledCopy.heading}
              </p>
              {cancelledCopy.when && (
                <p className="text-xs m-0" style={{ color: 'var(--color-neutral-300)' }}>
                  Was planned for {cancelledCopy.when}
                </p>
              )}
              <p className="text-xs m-0" style={{ color: 'var(--color-neutral-400)' }}>
                {cancelledCopy.body}
              </p>
            </div>
            <Btn ghost className="!min-h-0 !py-1 text-xs shrink-0" onClick={dismissCancelledDetail}>
              Dismiss
            </Btn>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-2.5">
        <h2 className="text-sm font-bold text-white m-0">
          {inProgress.length > 0 ? 'Happening now' : 'Next session'}
        </h2>
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

      {!hasLive && !showAddForm && (
        <Card>
          <EmptyState
            icon="calendar"
            title="No session on the calendar"
            hint={isDm ? 'Use “+ Schedule session” to pick the next game night.' : 'Your DM hasn’t scheduled the next session yet.'}
          />
        </Card>
      )}

      {inProgress.map((s) => (
        <ScheduleItem
          key={s.id}
          campaignId={campaignId}
          schedule={s}
          hero
          happeningNow
          isDm={isDm}
          myIds={myIds}
          onChange={load}
        />
      ))}

      {inProgress.length > 0 && next && (
        <h2 className="text-sm font-bold text-white m-0">Next session</h2>
      )}

      {next && (
        <ScheduleItem
          campaignId={campaignId}
          schedule={next}
          hero={inProgress.length === 0}
          isDm={isDm}
          myIds={myIds}
          onChange={load}
        />
      )}

      {later.length > 0 && (
        <>
          <h2 className="text-sm font-bold text-white m-0">Later</h2>
          {later.map((s) => (
            <ScheduleItem key={s.id} campaignId={campaignId} schedule={s} isDm={isDm} myIds={myIds} onChange={load} />
          ))}
        </>
      )}

      <FeedCard campaignId={campaignId} isDm={isDm} onChange={load} />

      {past.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-bold text-white m-0">Past</h2>
          {past.map((s) => (
            <p key={s.id} className="text-muted text-xs m-0" {...entityTargetProps('scheduled_session', s.id)}>
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
  campaignId,
  schedule,
  hero = false,
  happeningNow = false,
  isDm,
  myIds,
  onChange,
}: {
  campaignId: number;
  schedule: ScheduledSessionWithRsvps;
  hero?: boolean;
  happeningNow?: boolean;
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

  async function patchDuration(durationMinutes: number) {
    setBusy(true);
    setError(null);
    try {
      // Mid-session duration edits redefine the end as scheduledAt + durationMinutes
      // and emit schedule.updated so dashboard/SSE clients invalidate live (#818).
      await api.patch<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}`, { durationMinutes });
      onChange();
    } catch {
      setError("Couldn't update the session length.");
    } finally {
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
    <Card className={hero || happeningNow ? '!border-[var(--color-accent)]' : ''}>
      <div className="space-y-3" {...entityTargetProps('scheduled_session', schedule.id)}>
        {error && <ErrorNote message={error} />}
        {happeningNow && (
          <p
            className="text-xs font-extrabold uppercase tracking-wide m-0"
            style={{ color: 'var(--color-accent-2-200, var(--color-accent))' }}
            role="status"
          >
            Happening now
          </p>
        )}
        <div className="flex items-baseline gap-2.5 flex-wrap">
          <span className={hero || happeningNow ? 'text-lg font-extrabold text-white' : 'text-sm font-bold text-white'}>
            {formatWhen(schedule.scheduledAt)}
          </span>
          {schedule.title && <span className="text-muted text-sm">{schedule.title}</span>}
          <span className="text-muted text-xs ml-auto">{formatDuration(schedule.durationMinutes)}</span>
        </div>
        {schedule.location && <p className="flex items-center gap-1 text-muted text-xs m-0"><GameIcon slug="position-marker" size={11} /> {schedule.location}</p>}
        {schedule.notes && <Markdown className="!text-sm !text-[color:var(--color-text)]">{schedule.notes}</Markdown>}

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

        {happeningNow && (
          <div className="flex gap-2 flex-wrap">
            {isDm && (
              <Link to={`/c/${campaignId}/encounters`} className="btn btn-ghost !min-h-0 !py-1 text-xs">
                Encounters
              </Link>
            )}
            <Link to={`/c/${campaignId}/screen`} className="btn btn-ghost !min-h-0 !py-1 text-xs">
              Player display
            </Link>
            <Link to={`/c/${campaignId}/notes`} className="btn btn-ghost !min-h-0 !py-1 text-xs">
              Session notes
            </Link>
          </div>
        )}

        {isDm && (
          <div className="flex gap-2 flex-wrap">
            {happeningNow && (
              <>
                <Btn
                  ghost
                  className="!min-h-0 !py-1 text-xs"
                  disabled={busy || schedule.durationMinutes >= 1440}
                  onClick={() => void patchDuration(extendSessionDurationMinutes(schedule.durationMinutes, 30))}
                >
                  Extend +30 min
                </Btn>
                <Btn
                  ghost
                  className="!min-h-0 !py-1 text-xs"
                  disabled={busy}
                  onClick={() => void patchDuration(endSessionDurationMinutes(schedule.scheduledAt))}
                >
                  End session
                </Btn>
              </>
            )}
            <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={() => setEditing(true)}>
              Edit
            </Btn>
            <Btn danger ghost className="!min-h-0 !py-1 text-xs" onClick={() => setConfirmingCancel(true)} busy={busy}>
              Cancel session
            </Btn>
          </div>
        )}
      </div>

      {confirmingCancel && (
        <ConfirmDialog
          title="Cancel this session?"
          body="The scheduled session and everyone's RSVPs will be removed."
          confirmLabel="Cancel session"
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
        durationMinutes: (() => {
          if (!Number.isFinite(minutes)) return initial ? initial.durationMinutes : 240;
          // Edits may keep end-session values in 0..14; create still requires >=15.
          if (initial) return Math.min(1440, Math.max(0, minutes));
          return minutes >= 15 ? Math.min(minutes, 1440) : 240;
        })(),
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
          <TextInput type="number" min={initial ? 0 : 15} max={1440} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} />
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
  onChange,
}: {
  campaignId: number;
  isDm: boolean;
  /** Schedule-level reload — invoked after rotate/disable so the list stays fresh. */
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);

  // The calendar feed is an AUXILIARY panel (issue #697): it loads on its own so a
  // feed outage degrades only this card — never the schedule list above, and never a
  // page-level error/not-found. `retry` re-fetches only this feed.
  const feedPanel = usePanelData<CalendarFeed>(
    useCallback(() => api.get<CalendarFeed>(`${API}/campaigns/${campaignId}/calendar-feed`), [campaignId]),
    true,
    "Couldn't load the calendar feed.",
  );
  const feed = feedPanel.data;
  const feedError = feedPanel.error;

  const absoluteUrl = feed?.url ? `${window.location.origin}${feed.url}` : null;

  async function rotate() {
    setBusy(true);
    setMutateError(null);
    try {
      // The rotate endpoint returns the new feed directly (see
      // CampaignCalendarFeedController.rotate) — fold it into the panel cache instead
      // of an extra GET via feedPanel.retry(), which also avoids rendering a stale URL
      // if that follow-up fetch failed.
      const next = await api.post<CalendarFeed>(`${API}/campaigns/${campaignId}/calendar-feed`);
      feedPanel.setData(next);
      onChange();
    } catch {
      setMutateError("Couldn't update the calendar feed.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMutateError(null);
    try {
      // DELETE returns the disabled feed payload (null token/url); use it to update the
      // panel directly instead of a follow-up GET, so the URL vanishes immediately even
      // if a later fetch would have failed.
      const next = await api.delete<CalendarFeed>(`${API}/campaigns/${campaignId}/calendar-feed`);
      feedPanel.setData(next);
      onChange();
    } catch {
      setMutateError("Couldn't disable the calendar feed.");
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
            <Btn danger ghost className="!min-h-0 !py-1 text-xs" onClick={disable} busy={busy}>
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
      {mutateError && <ErrorNote message={mutateError} />}
      {/* Auxiliary panel failure: inline, panel-scoped, retry-only-this-feed (#697). */}
      {feedError && !feed ? (
        <ErrorNote message={feedError} onRetry={feedPanel.retry} />
      ) : feedPanel.loading && !feed ? (
        <Skeleton lines={2} />
      ) : absoluteUrl ? (
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
