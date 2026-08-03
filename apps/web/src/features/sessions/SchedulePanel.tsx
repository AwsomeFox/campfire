import { useTranslation } from 'react-i18next';
/**
 * Session scheduling (issue #13) — the "Schedule" tab of SessionsPage.
 * Planned game nights with per-member availability (RSVP yes/maybe/no) and the
 * campaign's ICS calendar feed (subscribe URL for Google/Apple/Outlook).
 * DM: schedule/edit/cancel sessions, enable/rotate/disable the feed.
 * Everyone: see what's coming, one-tap RSVP.
 */
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CalendarFeed, RsvpStatus, ScheduledSessionListPage, ScheduledSessionWithRsvps, SessionRsvp } from '@campfire/schema';
import {
  endSessionDurationMinutes,
  extendSessionDurationMinutes,
  partitionSchedules,
  scheduleEndsAtMs,
} from '@campfire/schema';
import { api, API, ApiError, isStaleWrite, translateApiError } from '../../lib/api';
import { joinPublicBase } from '../../lib/public-base';
import { usePanelData } from '../../lib/usePanelData';
import { formatDateTime, useFormattingLocale, useTimeFormat } from '../../lib/format';
import { parseLocalizedInteger } from '../../lib/i18nNumbers';
import { isImeComposing } from '../../lib/compositionSafeSubmit';
import { useAuth } from '../../app/auth';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Btn, Dialog, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { sanitizeFieldPrefix } from '../../components/Field';
import { LabeledField } from '../../components/LabeledField';
import { useAnnounce } from '../../components/Announcer';
import { Markdown } from '../../components/Markdown';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { CopyControl } from '../../components/CopyControl';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import { viewerRsvpIds } from '../../lib/dashboardRsvp';
import {
  cancelledScheduleDetailCopy,
  clearCancelledScheduleDetail,
  readCancelledScheduleDetail,
} from '../../lib/scheduleNotificationCopy';
import {
  initialRsvpSaveState,
  reduceRsvpSave,
  RSVP_GROUP_LEGEND,
  RSVP_NOTE_CLEAR_LABEL,
  RSVP_NOTE_CLEARED_ANNOUNCEMENT,
  RSVP_NOTE_HELP,
  RSVP_NOTE_LABEL,
  RSVP_NOTE_MAX_LEN,
  RSVP_NOTE_PLACEHOLDER,
  RSVP_NOTE_SAVE_FAILED_ANNOUNCEMENT,
  RSVP_NOTE_SAVE_LABEL,
  RSVP_NOTE_SAVED_ANNOUNCEMENT,
  RSVP_NOTE_SAVING_STATUS,
  RSVP_SAVE_FAILED_ANNOUNCEMENT,
  RSVP_SAVING_STATUS,
  rsvpDisplayStatus,
  rsvpNoteSaveRequest,
  rsvpNoteTooLongMessage,
  syncRsvpNoteDraft,
  rsvpSavedAnnouncement,
  rsvpStatusSummary,
  SCHEDULE_DURATION_HELP,
  SCHEDULE_FIELD_NAMES,
  SCHEDULE_FORM_ID_PREFIX,
  SCHEDULE_LOCATION_HELP,
  SCHEDULE_NOTES_HELP,
  SCHEDULE_TITLE_HELP,
  SCHEDULE_WHEN_HELP,
  SESSION_SAVE_FAILED_ANNOUNCEMENT,
  isoToDatetimeLocalInputValue,
  sessionScheduledAnnouncement,
  sessionUpdatedAnnouncement,
} from './schedulePanelA11y';
import { RsvpChooser } from './RsvpChooser';
import { StaleWriteConflict, type ConflictField } from '../../components/StaleWriteConflict';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

interface ScheduleDraft {
  scheduledAt: string;
  durationMinutes: number;
  title: string;
  location: string;
  notes: string;
}
const SCHEDULE_CONFLICT_FIELDS: Array<ConflictField<ScheduleDraft>> = [
  { key: 'scheduledAt', label: 'When' },
  { key: 'durationMinutes', label: 'Duration' },
  { key: 'title', label: 'Title', merge: true },
  { key: 'location', label: 'Where', merge: true },
  { key: 'notes', label: 'Notes', merge: true },
];

export function SchedulePanel({ campaignId, isDm }: { campaignId: number; isDm: boolean }) {
  const { t } = useTranslation();
  const { canDmWrite } = useCampaignAccess();
  const formattingLocale = useFormattingLocale();
  const timeFormat = useTimeFormat();
  const { me } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [schedules, setSchedules] = useState<ScheduledSessionWithRsvps[]>([]);
  const [pastSchedules, setPastSchedules] = useState<ScheduledSessionWithRsvps[]>([]);
  const [pastTotal, setPastTotal] = useState(0);
  const [pastHasMore, setPastHasMore] = useState(false);
  const [pastOffset, setPastOffset] = useState(0);
  const [loadingPast, setLoadingPast] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(() => searchParams.get('action') === 'new');
  const [restoreBusyId, setRestoreBusyId] = useState<number | null>(null);
  const [duplicateTarget, setDuplicateTarget] = useState<ScheduledSessionWithRsvps | null>(null);

  const closeAddForm = useCallback(() => {
    setShowAddForm(false);
    if (searchParams.get('action') === 'new') {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('action');
          return next;
        },
        { replace: true },
      );
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (searchParams.get('action') === 'new') {
      setShowAddForm(true);
    }
  }, [searchParams]);

  // Issue #820: cancelled-night deep link from the notifications bell.
  const cancelledIdRaw = searchParams.get('cancelled');
  const cancelledId = cancelledIdRaw && /^\d+$/.test(cancelledIdRaw) ? Number(cancelledIdRaw) : null;
  const cancelledDetail = useMemo(
    () => (cancelledId ? readCancelledScheduleDetail(cancelledId) : null),
    [cancelledId],
  );
  const cancelledCopy = useMemo(
    () => cancelledScheduleDetailCopy(cancelledDetail, formattingLocale, undefined, timeFormat),
    [cancelledDetail, formattingLocale, timeFormat],
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
      const [upcoming, pastPage] = await Promise.all([
        api.get<ScheduledSessionWithRsvps[]>(`${API}/campaigns/${campaignId}/schedule/upcoming`),
        api.get<ScheduledSessionListPage>(`${API}/campaigns/${campaignId}/schedule/past`),
      ]);
      setSchedules(upcoming);
      setPastSchedules(pastPage.items);
      setPastTotal(pastPage.total);
      setPastHasMore(pastPage.hasMore);
      setPastOffset(pastPage.items.length);
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 401 || e.status === 403))) {
        setError(t('sessions.errors.loadSchedule'));
      }
    } finally {
      setLoading(false);
    }
  }, [campaignId, t]);

  const loadMorePast = useCallback(async () => {
    if (!pastHasMore || loadingPast) return;
    setLoadingPast(true);
    setError(null);
    try {
      const pastPage = await api.get<ScheduledSessionListPage>(
        `${API}/campaigns/${campaignId}/schedule/past?offset=${pastOffset}`,
      );
      setPastSchedules((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...pastPage.items.filter((s) => !seen.has(s.id))];
      });
      setPastTotal(pastPage.total);
      setPastHasMore(pastPage.hasMore);
      setPastOffset((prev) => prev + pastPage.items.length);
    } catch {
      setError(t('sessions.errors.loadMorePastSessions'));
    } finally {
      setLoadingPast(false);
    }
  }, [campaignId, pastHasMore, loadingPast, pastOffset, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Issue #818: keep a game night in the live lists until scheduledAt+duration ends.
  // Wake at the next phase boundary (soonest upcoming start or in-progress end) so
  // "Next session" ↔ "Happening now" flips without a reload.
  const [scheduleNowMs, setScheduleNowMs] = useState(() => Date.now());
  const { inProgress, upcoming } = useMemo(
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

  function actionError(action: 'restore' | 'duplicate', err: unknown): string {
    const detail = translateApiError(err, t, { fallbackKey: 'sessions.errors.loadSchedule' });
    return `Couldn't ${action} scheduled session.${detail ? ` ${detail}` : ''}`;
  }

  async function restoreSchedule(id: number) {
    setRestoreBusyId(id);
    setError(null);
    try {
      await api.post<ScheduledSessionWithRsvps>(`${API}/schedule/${id}/restore`);
      await load();
    } catch (err) {
      setError(actionError('restore', err));
    } finally {
      setRestoreBusyId(null);
    }
  }

  async function duplicateSchedule(schedule: ScheduledSessionWithRsvps, body: ScheduleDraft) {
    setError(null);
    await api.post<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}/duplicate`, {
      scheduledAt: body.scheduledAt,
      durationMinutes: body.durationMinutes,
      title: body.title,
      location: body.location,
      notes: body.notes,
    });
    setDuplicateTarget(null);
    await load();
  }

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
              <GameIcon slug="calendar" size={UI_ICON_SIZE.md} />
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
            <Btn density="xs" ghost className="text-xs shrink-0" onClick={dismissCancelledDetail}>
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
        {canDmWrite && !showAddForm && (
          <Btn density="xs" className="text-xs" onClick={() => setShowAddForm(true)}>
            + Schedule session
          </Btn>
        )}
      </div>

      {canDmWrite && showAddForm && (
        <ScheduleForm
          onSubmit={async (body) => {
            await api.post<ScheduledSessionWithRsvps>(`${API}/campaigns/${campaignId}/schedule`, body);
            closeAddForm();
            void load();
          }}
          onCancel={closeAddForm}
        />
      )}

      {!hasLive && !showAddForm && (
        <Card>
          <EmptyState
            icon="calendar"
            title={t('sessions.empty.noCalendar')}
            hint={isDm ? t('sessions.empty.noCalendarHintDm') : t('sessions.empty.noCalendarHintPlayer')}
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

      {pastSchedules.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-bold text-white m-0">Past</h2>
          {pastSchedules.map((s) => (
            <div
              key={s.id}
              className="text-muted text-xs m-0 flex items-center gap-2 flex-wrap"
              {...entityTargetProps('scheduled_session', s.id)}
            >
              <span>
                {formatWhen(s.scheduledAt)}
                {s.title ? ` — ${s.title}` : ''}
              </span>
              {s.status !== 'scheduled' && (
                <span className="tag">{s.status === 'cancelled' ? 'Cancelled' : 'Completed'}</span>
              )}
              {s.status === 'cancelled' && s.cancellationReason && (
                <span>Reason: {s.cancellationReason}</span>
              )}
              {s.sessionId && (
                <Link to={`/c/${campaignId}/sessions?session=${s.sessionId}`} className="underline">
                  Recap
                </Link>
              )}
              {canDmWrite && s.status === 'cancelled' && (
                <Btn density="xs"
                  ghost
                  className="text-xs"
                  onClick={() => void restoreSchedule(s.id)}
                  busy={restoreBusyId === s.id}
                >
                  {restoreBusyId === s.id ? 'Restoring…' : 'Restore'}
                </Btn>
              )}
              {canDmWrite && (
                <Btn density="xs" ghost className="text-xs" onClick={() => setDuplicateTarget(s)}>
                  Duplicate
                </Btn>
              )}
            </div>
          ))}
          {pastHasMore && (
            <Btn density="xs"
              ghost
              type="button"
              className="text-xs"
              onClick={() => void loadMorePast()}
              disabled={loadingPast}
            >
              {loadingPast ? 'Loading…' : `Load more past (${pastSchedules.length} of ${pastTotal})`}
            </Btn>
          )}
        </div>
      )}

      {duplicateTarget && (
        <DuplicateScheduleDialog
          schedule={duplicateTarget}
          formatError={(err) => actionError('duplicate', err)}
          onCancel={() => setDuplicateTarget(null)}
          onSubmit={(body) => duplicateSchedule(duplicateTarget, body)}
        />
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
  const { t } = useTranslation();
  const { canDmWrite, canMemberWrite } = useCampaignAccess();
  const announce = useAnnounce();
  const rsvpLegendId = `schedule-rsvp-legend-${schedule.id}`;
  const rsvpStatusId = `schedule-rsvp-status-${schedule.id}`;
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancellationReason, setCancellationReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = schedule.rsvps.find((r) => myIds.has(r.userId));
  const [rsvpState, dispatchRsvp] = useReducer(
    reduceRsvpSave,
    mine?.status ?? null,
    initialRsvpSaveState,
  );

  // Issue #552: local draft of the RSVP note. Kept in a separate reducer-like
  // state so the caller can type freely without racing every keystroke against
  // the server; save-on-button-click (and clear-with-explicit-button) mirrors
  // the coarse-grained RSVP status control right above it.
  const persistedNote = mine?.note ?? '';
  const [noteDraft, setNoteDraft] = useState<string>(persistedNote);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const lastScheduleIdRef = useRef(schedule.id);
  const lastSyncedPersistedRef = useRef(persistedNote);

  useEffect(() => {
    dispatchRsvp({ type: 'sync', persisted: mine?.status ?? null });
    const scheduleChanged = lastScheduleIdRef.current !== schedule.id;
    if (scheduleChanged) {
      lastScheduleIdRef.current = schedule.id;
      lastSyncedPersistedRef.current = persistedNote;
      setNoteDraft(persistedNote);
      return;
    }
    setNoteDraft((prev) => {
      const next = syncRsvpNoteDraft(prev, lastSyncedPersistedRef.current, persistedNote, false);
      if (next !== prev) lastSyncedPersistedRef.current = persistedNote;
      return next;
    });
  }, [mine?.status, persistedNote, schedule.id]);

  const displayRsvp = rsvpDisplayStatus(rsvpState);
  const rsvpSaving = rsvpState.phase === 'saving';
  const noteFieldId = `schedule-rsvp-note-${schedule.id}`;
  const noteHelpId = `${noteFieldId}-help`;
  const noteStatusId = `${noteFieldId}-status`;
  const noteDraftLength = noteDraft.trim().length;
  const noteDirty = noteDraft.trim() !== persistedNote.trim();
  const noteTooLong = noteDraftLength > RSVP_NOTE_MAX_LEN;

  async function setRsvp(status: RsvpStatus) {
    if (rsvpSaving || noteSaving) return;
    const prior = rsvpState.persisted;
    if (status === prior && rsvpState.pending == null) return;
    dispatchRsvp({ type: 'select', status });
    setError(null);
    try {
      // #552: status-only change omits the note field so the server preserves
      // the existing note (see scheduling.service.setRsvp: `note ?? existing.note`).
      await api.put<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}/rsvp`, { status });
      dispatchRsvp({ type: 'saved', status });
      announce(rsvpSavedAnnouncement(status));
      onChange();
    } catch {
      dispatchRsvp({ type: 'failed' });
      setError(RSVP_SAVE_FAILED_ANNOUNCEMENT);
      announce(RSVP_SAVE_FAILED_ANNOUNCEMENT, { assertive: true });
    }
  }

  async function saveNote(explicitDraft?: string) {
    if (noteSaving || rsvpSaving) return;
    const draft = explicitDraft ?? noteDraft;
    if (draft.trim().length > RSVP_NOTE_MAX_LEN) {
      setNoteError(rsvpNoteTooLongMessage(draft.trim().length));
      announce(rsvpNoteTooLongMessage(draft.trim().length), { assertive: true });
      return;
    }
    const request = rsvpNoteSaveRequest(persistedNote, draft);
    if (!request) return; // no-op — draft matches persisted
    setNoteSaving(true);
    setNoteError(null);
    try {
      const updated = await api.put<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}/rsvp`, request);
      const savedNote =
        updated.rsvps.find((r) => myIds.has(r.userId))?.note ?? request.note;
      announce(
        request.note.length === 0 ? RSVP_NOTE_CLEARED_ANNOUNCEMENT : RSVP_NOTE_SAVED_ANNOUNCEMENT,
      );
      setNoteDraft(savedNote);
      lastSyncedPersistedRef.current = savedNote;
      onChange();
    } catch {
      setNoteError(RSVP_NOTE_SAVE_FAILED_ANNOUNCEMENT);
      announce(RSVP_NOTE_SAVE_FAILED_ANNOUNCEMENT, { assertive: true });
    } finally {
      setNoteSaving(false);
    }
  }

  async function clearNote() {
    if (noteSaving) return;
    setNoteDraft('');
    await saveNote('');
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      const reason = cancellationReason.trim();
      await api.delete(`${API}/schedule/${schedule.id}`, reason ? { json: { reason } } : undefined);
      onChange();
    } catch {
      setError(t('sessions.errors.cancelSession'));
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
      setError(t('sessions.errors.updateSessionLength'));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <ScheduleForm
        initial={schedule}
        onSubmit={async (body) => {
          const { expectedUpdatedAt, ...payload } = body;
          await api.patch<ScheduledSessionWithRsvps>(`${API}/schedule/${schedule.id}`, {
            ...payload,
            expectedUpdatedAt,
          });
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
        {schedule.location && <p className="flex items-center gap-1 text-muted text-xs m-0"><GameIcon slug="position-marker" size={UI_ICON_SIZE.xs} /> {schedule.location}</p>}
        {schedule.notes && <Markdown className="!text-sm !text-[color:var(--color-text)]">{schedule.notes}</Markdown>}
        
        {isDm && <PrepNotesEditor schedule={schedule} onChange={onChange} />}

        {canMemberWrite && (
        <>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            id={rsvpLegendId}
            className="text-[11px] font-bold text-secondary uppercase tracking-wide"
          >
            {RSVP_GROUP_LEGEND}
          </span>
          <RsvpChooser
            aria-labelledby={rsvpLegendId}
            value={displayRsvp}
            onChange={(status) => void setRsvp(status)}
            disabled={busy || rsvpSaving || noteSaving}
          />
          <span
            id={rsvpStatusId}
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {rsvpSaving ? RSVP_SAVING_STATUS : rsvpStatusSummary(displayRsvp)}
          </span>
        </div>

        {/* Issue #552: RSVP note editor. Only meaningful once the viewer has
            picked a status — hide it entirely when no RSVP is set. Explicit
            Save + Clear buttons; the note is intentionally NOT saved on
            keystroke (avoids racing the coarser RSVP status control). */}
        {displayRsvp && (
          <div className="space-y-1">
            <label
              htmlFor={noteFieldId}
              className="text-[11px] font-bold text-secondary uppercase tracking-wide block"
            >
              {RSVP_NOTE_LABEL}
            </label>
            <p id={noteHelpId} className="text-[11px] text-muted m-0">
              {RSVP_NOTE_HELP}
            </p>
            <div className="flex items-start gap-2 flex-wrap">
              <input
                id={noteFieldId}
                type="text"
                value={noteDraft}
                onChange={(e) => {
                  setNoteDraft(e.target.value);
                  if (noteError) setNoteError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isImeComposing(e) && noteDirty && !noteTooLong) {
                    e.preventDefault();
                    void saveNote();
                  }
                }}
                placeholder={RSVP_NOTE_PLACEHOLDER}
                aria-describedby={`${noteHelpId} ${noteStatusId}`}
                aria-invalid={noteTooLong || undefined}
                maxLength={RSVP_NOTE_MAX_LEN + 100 /* let the operator paste + trim rather than truncate silently */}
                disabled={noteSaving || rsvpSaving}
                className="input flex-1 min-w-0 !text-sm"
              />
              <Btn density="xs"
                ghost
                className="text-xs"
                disabled={!noteDirty || noteSaving || rsvpSaving || noteTooLong}
                busy={noteSaving}
                onClick={() => void saveNote()}
              >
                {RSVP_NOTE_SAVE_LABEL}
              </Btn>
              {persistedNote && (
                <Btn density="xs"
                  ghost
                  className="text-xs"
                  disabled={noteSaving || rsvpSaving}
                  onClick={() => void clearNote()}
                >
                  {RSVP_NOTE_CLEAR_LABEL}
                </Btn>
              )}
            </div>
            {noteTooLong && (
              <p className="text-xs" style={{ color: 'var(--color-danger, #ef4444)' }}>
                {rsvpNoteTooLongMessage(noteDraftLength)}
              </p>
            )}
            {noteError && !noteTooLong && (
              <p className="text-xs" style={{ color: 'var(--color-danger, #ef4444)' }}>
                {noteError}
              </p>
            )}
            <span
              id={noteStatusId}
              className="sr-only"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {noteSaving
                ? RSVP_NOTE_SAVING_STATUS
                : noteTooLong
                  ? rsvpNoteTooLongMessage(noteDraftLength)
                  : ''}
            </span>
          </div>
        )}
        </>
        )}

        {schedule.rsvps.length > 0 && <RsvpList rsvps={schedule.rsvps} />}

        {happeningNow && (
          <div className="flex gap-2 flex-wrap">
            {isDm && (
              <Link to={`/c/${campaignId}/encounters`} className="btn btn-ghost text-xs cf-density-xs">
                Encounters
              </Link>
            )}
            <Link to={`/c/${campaignId}/screen`} className="btn btn-ghost text-xs cf-density-xs">
              Player display
            </Link>
            <Link to={`/c/${campaignId}/notes`} className="btn btn-ghost text-xs cf-density-xs">
              Session notes
            </Link>
          </div>
        )}

        {canDmWrite && (
          <div className="flex gap-2 flex-wrap">
            {happeningNow && (
              <>
                <Btn density="xs"
                  ghost
                  className="text-xs"
                  disabled={busy || schedule.durationMinutes >= 1440}
                  onClick={() => void patchDuration(extendSessionDurationMinutes(schedule.durationMinutes, 30))}
                >
                  Extend +30 min
                </Btn>
                <Btn density="xs"
                  ghost
                  className="text-xs"
                  disabled={busy}
                  onClick={() => void patchDuration(endSessionDurationMinutes(schedule.scheduledAt))}
                >
                  End session
                </Btn>
              </>
            )}
            <Btn density="xs" ghost className="text-xs" onClick={() => setEditing(true)}>
              Edit
            </Btn>
            {schedule.sessionId == null ? (
              <Link
                to={`/c/${campaignId}/sessions?action=new-recap&fromSchedule=${schedule.id}`}
                className="btn btn-ghost text-xs cf-density-xs"
              >
                Log session recap
              </Link>
            ) : (
              <Link
                to={`/c/${campaignId}/sessions?session=${schedule.sessionId}`}
                className="btn btn-ghost text-xs cf-density-xs"
              >
                View session recap
              </Link>
            )}
            <Btn density="xs" danger ghost className="text-xs" onClick={() => setConfirmingCancel(true)} busy={busy}>
              Cancel session
            </Btn>
          </div>
        )}
        {isDm && (
          <RevisionHistoryPanel
            entityType="scheduled_session"
            entityId={schedule.id}
            currentSnapshot={{ notes: schedule.notes }}
            expectedUpdatedAt={schedule.updatedAt}
            onRestored={onChange}
            label="Schedule notes history"
          />
        )}
      </div>

      {confirmingCancel && (
        <ConfirmDialog
          title="Cancel this session?"
          body={
            <div className="space-y-2">
              <p className="m-0">
                The schedule will be marked cancelled. RSVPs and attendance history stay attached for audit and restore.
              </p>
              <label className="block text-xs font-bold text-secondary uppercase tracking-wide" htmlFor={`cancel-reason-${schedule.id}`}>
                Reason (optional)
              </label>
              <textarea
                id={`cancel-reason-${schedule.id}`}
                className="input w-full min-h-[70px]"
                value={cancellationReason}
                maxLength={1000}
                onChange={(event) => setCancellationReason(event.target.value)}
                disabled={busy}
              />
            </div>
          }
          confirmLabel="Cancel session"
          busy={busy}
          onConfirm={cancel}
          onCancel={() => {
            setConfirmingCancel(false);
            setCancellationReason('');
          }}
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

function DuplicateScheduleDialog({
  schedule,
  formatError,
  onSubmit,
  onCancel,
}: {
  schedule: ScheduledSessionWithRsvps;
  formatError: (err: unknown) => string;
  onSubmit: (body: ScheduleDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const announce = useAnnounce();
  const reactId = useId();
  const idPrefix = `duplicate-schedule-${schedule.id}-${sanitizeFieldPrefix(reactId)}`;
  const titleId = `${idPrefix}-title`;
  const formErrorId = `${idPrefix}-error`;
  const [when, setWhen] = useState(isoToDatetimeLocalInputValue(schedule.scheduledAt));
  const [duration, setDuration] = useState(String(schedule.durationMinutes));
  const [title, setTitle] = useState(schedule.title);
  const [location, setLocation] = useState(schedule.location);
  const [notes, setNotes] = useState(schedule.notes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = Date.parse(when);
    const minutes = Number(duration);
    if (Number.isNaN(parsed)) {
      setError('Pick a valid date and time to duplicate this session.');
      return;
    }
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 1440) {
      setError('Duration must be between 15 and 1440 minutes.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        scheduledAt: new Date(parsed).toISOString(),
        durationMinutes: Math.floor(minutes),
        title: title.trim(),
        location: location.trim(),
        notes,
      });
      announce('Scheduled session duplicated.');
    } catch (err) {
      const message = formatError(err);
      setError(message);
      announce(message, { assertive: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog title="Duplicate scheduled session" titleId={titleId} onBackdropClick={saving ? undefined : onCancel}>
      <form className="space-y-3" onSubmit={(event) => void save(event)} aria-describedby={error ? formErrorId : undefined}>
        <p className="m-0 text-xs text-muted">
          Copy the cancelled or past session into a new scheduled game night. RSVPs are not copied.
        </p>
        {error && (
          <div id={formErrorId}>
            <ErrorNote message={error} />
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LabeledField
            idPrefix={idPrefix}
            name={SCHEDULE_FIELD_NAMES.when}
            type="datetime-local"
            label="When"
            help={SCHEDULE_WHEN_HELP}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            disabled={saving}
            describedBy={error ? formErrorId : undefined}
            autoFocus
          />
          <LabeledField
            idPrefix={idPrefix}
            name={SCHEDULE_FIELD_NAMES.durationMinutes}
            type="number"
            label="Duration (minutes)"
            help={SCHEDULE_DURATION_HELP}
            min={15}
            max={1440}
            step={15}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            disabled={saving}
            describedBy={error ? formErrorId : undefined}
          />
        </div>
        <LabeledField
          idPrefix={idPrefix}
          name={SCHEDULE_FIELD_NAMES.title}
          label="Title"
          help={SCHEDULE_TITLE_HELP}
          placeholder='e.g. "Session 12 — the heist"'
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={saving}
          describedBy={error ? formErrorId : undefined}
        />
        <LabeledField
          idPrefix={idPrefix}
          name={SCHEDULE_FIELD_NAMES.location}
          label="Where"
          help={SCHEDULE_LOCATION_HELP}
          placeholder="Sam's place, VTT link…"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          disabled={saving}
          describedBy={error ? formErrorId : undefined}
        />
        <LabeledField
          idPrefix={idPrefix}
          name={SCHEDULE_FIELD_NAMES.notes}
          as="textarea"
          label="Notes"
          help={SCHEDULE_NOTES_HELP}
          placeholder="Bring level 5 sheets, we start on time…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          minHeight={60}
          disabled={saving}
          describedBy={error ? formErrorId : undefined}
        />
        <div className="dialog-actions">
          <Btn ghost type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </Btn>
          <Btn type="submit" busy={saving} disabled={saving}>
            {saving ? 'Duplicating…' : 'Duplicate'}
          </Btn>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: ScheduledSessionWithRsvps;
  onSubmit: (body: ScheduleDraft & { expectedUpdatedAt?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const announce = useAnnounce();
  const reactId = useId();
  const idPrefix = initial
    ? `${SCHEDULE_FORM_ID_PREFIX}-${initial.id}`
    : `${SCHEDULE_FORM_ID_PREFIX}-${sanitizeFieldPrefix(reactId)}`;
  const formErrorId = `${idPrefix}-error`;
  const [when, setWhen] = useState(initial ? isoToDatetimeLocalInputValue(initial.scheduledAt) : '');
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 240));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [location, setLocation] = useState(initial?.location ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [base, setBase] = useState<ScheduleDraft | null>(initial ? {
    scheduledAt: initial.scheduledAt,
    durationMinutes: initial.durationMinutes,
    title: initial.title,
    location: initial.location,
    notes: initial.notes,
  } : null);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(initial?.updatedAt ?? null);
  const [conflict, setConflict] = useState<{ base: ScheduleDraft; theirs: ScheduleDraft } | null>(null);

  function applyDraft(value: ScheduleDraft) {
    setWhen(isoToDatetimeLocalInputValue(value.scheduledAt));
    setDuration(String(value.durationMinutes));
    setTitle(value.title);
    setLocation(value.location);
    setNotes(value.notes);
  }

  async function save() {
    const parsed = Date.parse(when);
    const durationParsed = parseLocalizedInteger(duration);
    const minutes = durationParsed.ok ? durationParsed.value : NaN;
    if (Number.isNaN(parsed)) {
      setError('Pick a date and time.');
      return;
    }
    setSaving(true);
    setError(null);
    const body: ScheduleDraft = {
      scheduledAt: new Date(parsed).toISOString(),
      durationMinutes: (() => {
        if (!Number.isFinite(minutes)) return initial ? initial.durationMinutes : 240;
        if (initial) return Math.min(1440, Math.max(0, minutes));
        return minutes >= 15 ? Math.min(minutes, 1440) : 240;
      })(),
      title: title.trim(),
      location: location.trim(),
      notes,
    };
    try {
      await onSubmit({ ...body, expectedUpdatedAt: expectedUpdatedAt ?? undefined });
      announce(initial ? sessionUpdatedAnnouncement(body.title) : sessionScheduledAnnouncement(body.title));
    } catch (err) {
      if (initial && isStaleWrite(err)) {
        try {
          const latest = await api.get<ScheduledSessionWithRsvps>(`${API}/schedule/${initial.id}`);
          const theirs: ScheduleDraft = {
            scheduledAt: latest.scheduledAt,
            durationMinutes: latest.durationMinutes,
            title: latest.title,
            location: latest.location,
            notes: latest.notes,
          };
          setConflict({ base: base ?? body, theirs });
          setBase(theirs);
          setExpectedUpdatedAt(latest.updatedAt);
        } catch {
          setError("The schedule changed, but the latest version couldn't be loaded. Your draft is still here.");
          announce("The schedule changed, but the latest version couldn't be loaded. Your draft is still here.", { assertive: true });
        }
      } else {
        setError(SESSION_SAVE_FAILED_ANNOUNCEMENT);
        announce(SESSION_SAVE_FAILED_ANNOUNCEMENT, { assertive: true });
      }
      setSaving(false);
    }
  }

  const conflictMine: ScheduleDraft = {
    scheduledAt: Number.isNaN(Date.parse(when)) ? when : new Date(Date.parse(when)).toISOString(),
    durationMinutes: Number(duration),
    title,
    location,
    notes,
  };

  return (
    <Card
      className="space-y-3"
      role="region"
      aria-label={initial ? 'Edit scheduled session' : 'Schedule the next session'}
      aria-describedby={error ? formErrorId : undefined}
    >
      <h2 className="font-bold text-white text-sm">{initial ? 'Edit scheduled session' : 'Schedule the next session'}</h2>
      {error && (
        <div id={formErrorId}>
          <ErrorNote message={error} />
        </div>
      )}
      {conflict && (
        <StaleWriteConflict
          base={conflict.base}
          mine={conflictMine}
          theirs={conflict.theirs}
          fields={SCHEDULE_CONFLICT_FIELDS}
          onResolve={(key, value) => applyDraft({ ...conflictMine, [key]: value } as ScheduleDraft)}
          onReloadAll={() => { applyDraft(conflict.theirs); setBase(conflict.theirs); setConflict(null); }}
        />
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LabeledField
          idPrefix={idPrefix}
          name={SCHEDULE_FIELD_NAMES.when}
          type="datetime-local"
          label="When"
          help={SCHEDULE_WHEN_HELP}
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          disabled={saving}
          describedBy={error ? formErrorId : undefined}
        />
        <LabeledField
          idPrefix={idPrefix}
          name={SCHEDULE_FIELD_NAMES.durationMinutes}
          type="number"
          label="Duration (minutes)"
          help={SCHEDULE_DURATION_HELP}
          min={initial ? 0 : 15}
          max={1440}
          step={15}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          disabled={saving}
          describedBy={error ? formErrorId : undefined}
        />
      </div>
      <LabeledField
        idPrefix={idPrefix}
        name={SCHEDULE_FIELD_NAMES.title}
        label="Title"
        help={SCHEDULE_TITLE_HELP}
        placeholder='e.g. "Session 12 — the heist"'
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={saving}
        describedBy={error ? formErrorId : undefined}
      />
      <LabeledField
        idPrefix={idPrefix}
        name={SCHEDULE_FIELD_NAMES.location}
        label="Where"
        help={SCHEDULE_LOCATION_HELP}
        placeholder="Sam's place, VTT link…"
        value={location}
        onChange={(e) => setLocation(e.target.value)}
        disabled={saving}
        describedBy={error ? formErrorId : undefined}
      />
      <LabeledField
        idPrefix={idPrefix}
        name={SCHEDULE_FIELD_NAMES.notes}
        as="textarea"
        label="Notes"
        help={SCHEDULE_NOTES_HELP}
        placeholder="Bring level 5 sheets, we start on time…"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        minHeight={60}
        disabled={saving}
        describedBy={error ? formErrorId : undefined}
      />
      <div className="flex gap-2 justify-end">
        <Btn density="compact" ghost className="text-xs" onClick={onCancel} disabled={saving}>
          Cancel
        </Btn>
        <Btn density="compact" className="text-xs" onClick={() => void save()} disabled={saving} aria-busy={saving || undefined}>
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
  const { t } = useTranslation();
  const { canDmWrite } = useCampaignAccess();
  const [busy, setBusy] = useState(false);
  const [mutateError, setMutateError] = useState<string | null>(null);
  const feedUrlId = `calendar-feed-url-${campaignId}`;

  // The calendar feed is an AUXILIARY panel (issue #697): it loads on its own so a
  // feed outage degrades only this card — never the schedule list above, and never a
  // page-level error/not-found. `retry` re-fetches only this feed.
  const feedPanel = usePanelData<CalendarFeed>(
    useCallback(() => api.get<CalendarFeed>(`${API}/campaigns/${campaignId}/calendar-feed`), [campaignId]),
    true,
    t('sessions.errors.loadCalendarFeed'),
  );
  const feed = feedPanel.data;
  const feedError = feedPanel.error;

  // The server emits the ICS feed URL unprefixed (it has no knowledge of the
  // reverse-proxy subpath — the proxy strips the prefix before forwarding, so
  // routing is root-relative inside Nest). The browser, though, must hit the
  // prefixed URL. joinPublicBase re-adds the deployment prefix (issue #798).
  const absoluteUrl = feed?.url ? `${window.location.origin}${joinPublicBase(feed.url)}` : null;

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
      setMutateError(t('sessions.errors.updateCalendarFeed'));
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
      setMutateError(t('sessions.errors.disableCalendarFeed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-sm font-bold text-white"><GameIcon slug="calendar" size={UI_ICON_SIZE.sm} /> Calendar feed</span>
        <div className="flex-1" />
        {canDmWrite && absoluteUrl && (
          <>
            <Btn density="xs" ghost className="text-xs" onClick={rotate} disabled={busy} title="Generate a new URL; the old one stops working">
              Rotate
            </Btn>
            <Btn density="xs" danger ghost className="text-xs" onClick={disable} busy={busy}>
              Disable
            </Btn>
          </>
        )}
        {canDmWrite && !absoluteUrl && (
          <Btn density="compact" className="text-xs" onClick={rotate} disabled={busy}>
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
              id={feedUrlId}
              className="text-[11px] px-2 py-1.5 rounded flex-1 min-w-0 overflow-x-auto whitespace-nowrap"
              style={{ background: 'var(--color-neutral-900)', color: 'var(--color-text)' }}
            >
              {absoluteUrl}
            </code>
            {absoluteUrl && (
              <CopyControl density="xs"
                text={absoluteUrl}
                selectTargetId={feedUrlId}
                ghost
                className="text-xs shrink-0"
                successAnnouncement="Calendar feed URL copied to clipboard."
                failureAnnouncement="Copy failed. Clipboard blocked — select the URL and copy it manually."
              />
            )}
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
    timeZoneName: 'short',
  });
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

function PrepNotesEditor({ schedule, onChange }: { schedule: ScheduledSessionWithRsvps; onChange: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(schedule.prepNotes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== (schedule.prepNotes ?? '');

  async function save() {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`${API}/schedule/${schedule.id}`, { prepNotes: draft });
      onChange();
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'encounters.errors.actionFailed' }) || 'Failed to save prep notes');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 pt-3 border-t border-[var(--color-neutral-700)]">
      <label className="text-[11px] font-bold text-secondary uppercase tracking-wide block mb-1">
        DM Prep Notes (Private)
      </label>
      <MarkdownEditor
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={saving}
        className="input w-full min-h-[80px] !text-sm mt-1"
        placeholder="Hidden from players..."
      />
      {error && <p className="text-danger text-xs mt-1">{error}</p>}
      {dirty && (
        <div className="flex justify-end gap-2 mt-2">
          <Btn ghost density="xs" onClick={() => setDraft(schedule.prepNotes ?? '')} disabled={saving}>Cancel</Btn>
          <Btn density="xs" onClick={() => void save()} busy={saving}>Save</Btn>
        </div>
      )}
    </div>
  );
}
