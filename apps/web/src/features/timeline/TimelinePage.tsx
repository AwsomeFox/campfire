/**
 * In-world calendar / campaign timeline — issue #63.
 *
 * The Sessions page tracks real-world play dates; this page tracks the FICTION:
 * a campaign's "current in-world date" plus a DM-sequenced list of in-world events
 * ("Founding of Neverwinter — Year 87 DR"). Fantasy dates aren't ISO-parseable, so
 * events order by a DM-controlled sortIndex, not by the free-text date string.
 *
 * Route (wired in app/router.tsx):
 *   /c/:campaignId/timeline  →  features/timeline/TimelinePage.tsx (default export)
 *
 * Data:
 *   GET/PUT  /api/v1/campaigns/:campaignId/timeline/calendar
 *   GET/POST /api/v1/campaigns/:campaignId/timeline
 *   PATCH/DELETE /api/v1/timeline/:id
 *
 * Authoring a11y (issue #453): create/edit EventForm fields use associated
 * labels (htmlFor/id), format/order help, DM-secret visibility copy, field
 * errors with logical focus, and keyboard-complete controls.
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import type { TimelineEvent, TimelineCalendar, TimelineListPage } from '@campfire/schema';
import { TIMELINE_LIST_DEFAULT_LIMIT } from '@campfire/schema';
import { api, API, ApiError, isStaleWrite } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Markdown } from '../../components/Markdown';
import { Card, Skeleton, ErrorNote, EmptyState, Btn, TextInput, TextArea, DmPanel } from '../../components/ui';
import { AudienceField, audienceToHidden, type AudienceValue } from '../../components/AudienceField';
import { VisibleToPlayersBar } from '../../components/VisibleToPlayersBar';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import { PageTitle } from '../../components/PageTitle';
import { StaleWriteConflict, type ConflictField } from '../../components/StaleWriteConflict';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { DraftWithAiButton } from '../ai-dm/DraftWithAiButton';
import {
  TIMELINE_BODY_HELP,
  TIMELINE_BODY_LABEL,
  TIMELINE_DATE_HELP,
  TIMELINE_DM_SECRET_HELP,
  TIMELINE_DM_SECRET_LABEL,
  TIMELINE_EDIT_FORM_PREFIX,
  TIMELINE_NEW_FORM_PREFIX,
  TIMELINE_ORDER_HELP,
  TIMELINE_ORDER_LABEL,
  firstTimelineFieldErrorId,
  timelineFieldErrorId,
  timelineFieldHelpId,
  timelineFieldId,
  validateTimelineEventDraft,
  type TimelineEventFieldErrors,
} from './timelineFormA11y';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

interface EventDraft {
  title: string;
  inWorldDate: string;
  era: string;
  sortIndex: string;
  body: string;
  dmSecret: string;
  /** Audience at edit time; create form uses a separate AudienceField defaulting to DM-only (#754). */
  hidden: boolean;
}

interface CalendarDraft { currentDate: string; note: string }
const EVENT_CONFLICT_FIELDS: Array<ConflictField<EventDraft>> = [
  { key: 'title', label: 'Title', merge: true },
  { key: 'inWorldDate', label: 'In-world date', merge: true },
  { key: 'era', label: 'Era', merge: true },
  { key: 'sortIndex', label: 'Order' },
  { key: 'body', label: 'Description', merge: true },
  { key: 'dmSecret', label: 'DM secret', merge: true },
  { key: 'hidden', label: 'Hidden from players' },
];
const CALENDAR_CONFLICT_FIELDS: Array<ConflictField<CalendarDraft>> = [
  { key: 'currentDate', label: 'Current in-world date', merge: true },
  { key: 'note', label: 'Calendar note', merge: true },
];

function emptyDraft(sortIndex = 0): EventDraft {
  // #754: new timeline events default to DM-only prep.
  return { title: '', inWorldDate: '', era: '', sortIndex: String(sortIndex), body: '', dmSecret: '', hidden: true };
}

function draftFrom(e: TimelineEvent): EventDraft {
  return {
    title: e.title,
    inWorldDate: e.inWorldDate,
    era: e.era,
    sortIndex: String(e.sortIndex),
    body: e.body,
    dmSecret: e.dmSecret,
    hidden: e.hidden,
  };
}

function draftToPayload(d: EventDraft) {
  const parsed = Number.parseInt(d.sortIndex, 10);
  return {
    title: d.title.trim(),
    inWorldDate: d.inWorldDate.trim(),
    era: d.era.trim(),
    sortIndex: Number.isFinite(parsed) ? parsed : 0,
    body: d.body,
    dmSecret: d.dmSecret,
    hidden: d.hidden,
  };
}

function focusField(id: string) {
  requestAnimationFrame(() => {
    document.getElementById(id)?.focus();
  });
}

export default function TimelinePage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { isDm, canDmWrite } = useCampaignAccess();

  const [calendar, setCalendar] = useState<TimelineCalendar | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // DM editing state
  const [editingCalendar, setEditingCalendar] = useState(false);
  const [calDraft, setCalDraft] = useState({ currentDate: '', note: '' });
  const [calBase, setCalBase] = useState<CalendarDraft | null>(null);
  const [calExpected, setCalExpected] = useState<string | null>(null);
  const [calConflict, setCalConflict] = useState<{ base: CalendarDraft; theirs: CalendarDraft } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<EventDraft>(emptyDraft());
  const [newFieldErrors, setNewFieldErrors] = useState<TimelineEventFieldErrors>({});
  // #754: create-time audience defaults to DM-only (separate from draft.hidden for edit).
  const [createAudience, setCreateAudience] = useState<AudienceValue>('dm');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EventDraft>(emptyDraft());
  const [editFieldErrors, setEditFieldErrors] = useState<TimelineEventFieldErrors>({});
  const [editBase, setEditBase] = useState<EventDraft | null>(null);
  const [editExpected, setEditExpected] = useState<string | null>(null);
  const [eventConflict, setEventConflict] = useState<{ base: EventDraft; theirs: EventDraft } | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<{ id: number; title: string } | null>(null);
  const [pendingUndo, setPendingUndo] = useState<{ id: number; title: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Selected timeline event for the Visible-to-players bar (#754). Set on public
  // create and when the DM opens Edit on an event so existing visible events get the bar.
  const [visibilityEventId, setVisibilityEventId] = useState<number | null>(null);

  const newEventTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const editTriggerRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const calendarEditTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreNewEventFocusRef = useRef(false);
  const restoreEditFocusIdRef = useRef<number | null>(null);
  const restoreCalendarFocusRef = useRef(false);
  const loadSequence = useRef(0);

  const buildTimelineQuery = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      params.set('limit', String(TIMELINE_LIST_DEFAULT_LIMIT));
      if (cursor) params.set('cursor', cursor);
      return `${API}/campaigns/${cid}/timeline?${params.toString()}`;
    },
    [cid],
  );

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [cal, page] = await Promise.all([
        api.get<TimelineCalendar>(`${API}/campaigns/${cid}/timeline/calendar`),
        api.get<TimelineListPage>(buildTimelineQuery()),
      ]);
      if (sequence !== loadSequence.current) return;
      setCalendar(cal);
      setEvents(page.items);
      setTotal(page.total);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (sequence === loadSequence.current) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setForbidden(true);
        else setError("Couldn't load the timeline.");
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [cid, buildTimelineQuery]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || loading) return;
    const sequence = ++loadSequence.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.get<TimelineListPage>(buildTimelineQuery(nextCursor));
      if (sequence !== loadSequence.current) return;
      setEvents((prev) => {
        const seen = new Set(prev.map((e) => e.id));
        return [...prev, ...page.items.filter((e) => !seen.has(e.id))];
      });
      setTotal(page.total);
      setHasMore(page.hasMore);
      setNextCursor(page.nextCursor);
    } catch {
      if (sequence === loadSequence.current) setError("Couldn't load more events.");
    } finally {
      if (sequence === loadSequence.current) setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, loading, buildTimelineQuery]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  useEffect(() => {
    if (creating) {
      focusField(timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'title'));
      return;
    }
    if (restoreNewEventFocusRef.current) {
      restoreNewEventFocusRef.current = false;
      requestAnimationFrame(() => newEventTriggerRef.current?.focus());
    }
  }, [creating]);

  useEffect(() => {
    if (editingId != null) {
      focusField(timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'title'));
      return;
    }
    const restoreId = restoreEditFocusIdRef.current;
    if (restoreId != null) {
      restoreEditFocusIdRef.current = null;
      requestAnimationFrame(() => editTriggerRefs.current.get(restoreId)?.focus());
    }
  }, [editingId]);

  useEffect(() => {
    if (editingCalendar) return;
    if (restoreCalendarFocusRef.current) {
      restoreCalendarFocusRef.current = false;
      requestAnimationFrame(() => calendarEditTriggerRef.current?.focus());
    }
  }, [editingCalendar]);

  useEffect(() => {
    const refreshAfterResume = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', refreshAfterResume);
    return () => document.removeEventListener('visibilitychange', refreshAfterResume);
  }, [load]);

  const saveCalendar = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.put<TimelineCalendar>(`${API}/campaigns/${cid}/timeline/calendar`, {
        currentDate: calDraft.currentDate.trim(),
        note: calDraft.note,
        expectedUpdatedAt: calExpected ?? undefined,
      });
      setCalendar(updated);
      restoreCalendarFocusRef.current = true;
      setEditingCalendar(false);
      setCalConflict(null);
      setHistoryNonce((value) => value + 1);
    } catch (err) {
      if (isStaleWrite(err)) {
        try {
          const latest = await api.get<TimelineCalendar>(`${API}/campaigns/${cid}/timeline/calendar`);
          const theirs = { currentDate: latest.currentDate, note: latest.note };
          setCalConflict({ base: calBase ?? calDraft, theirs });
          setCalBase(theirs);
          setCalExpected(latest.updatedAt);
          setCalendar(latest);
        } catch {
          setActionError("The calendar changed, but the latest version couldn't be loaded. Your draft is still here.");
        }
      } else setActionError("Couldn't save the current date.");
    } finally {
      setBusy(false);
    }
  };

  const createEvent = async () => {
    const errors = validateTimelineEventDraft(newDraft);
    setNewFieldErrors(errors);
    if (errors.title || errors.order) {
      const focusId = firstTimelineFieldErrorId(TIMELINE_NEW_FORM_PREFIX, errors);
      if (focusId) focusField(focusId);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const payload = { ...draftToPayload(newDraft), hidden: audienceToHidden(createAudience) };
      const created = await api.post<TimelineEvent>(`${API}/campaigns/${cid}/timeline`, payload);
      setNewDraft(emptyDraft());
      setNewFieldErrors({});
      setCreateAudience('dm');
      restoreNewEventFocusRef.current = true;
      setCreating(false);
      if (!created.hidden) setVisibilityEventId(created.id);
      await load();
    } catch {
      setActionError("Couldn't create the event.");
      focusField(timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'title'));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: number) => {
    const errors = validateTimelineEventDraft(editDraft);
    setEditFieldErrors(errors);
    if (errors.title || errors.order) {
      const focusId = firstTimelineFieldErrorId(TIMELINE_EDIT_FORM_PREFIX, errors);
      if (focusId) focusField(focusId);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.patch<TimelineEvent>(`${API}/timeline/${id}`, {
        ...draftToPayload(editDraft),
        expectedUpdatedAt: editExpected ?? undefined,
      });
      setEditFieldErrors({});
      restoreEditFocusIdRef.current = id;
      setEditingId(null);
      setEventConflict(null);
      setHistoryNonce((value) => value + 1);
      await load();
    } catch (err) {
      if (isStaleWrite(err)) {
        try {
          const latest = await api.get<TimelineEvent>(`${API}/timeline/${id}`);
          const theirs = draftFrom(latest);
          setEventConflict({ base: editBase ?? editDraft, theirs });
          setEditBase(theirs);
          setEditExpected(latest.updatedAt);
          setEvents((list) => list.map((event) => event.id === id ? latest : event));
        } catch {
          setActionError("The event changed, but the latest version couldn't be loaded. Your draft is still here.");
        }
      } else {
        setActionError("Couldn't save the event.");
        focusField(timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'title'));
      }
    } finally {
      setBusy(false);
    }
  };

  async function removeEvent(id: number) {
    setDeleting(true);
    setActionError(null);
    try {
      await api.delete(`${API}/timeline/${id}`);
      const deleted = events.find((event) => event.id === id);
      setConfirmingDelete(null);
      setEditFieldErrors({});
      setEditingId(null);
      if (deleted) setPendingUndo({ id, title: deleted.title });
      await load();
      requestAnimationFrame(() => {
        if (newEventTriggerRef.current) {
          newEventTriggerRef.current.focus();
          return;
        }
        if (creating) {
          document.getElementById(timelineFieldId(TIMELINE_NEW_FORM_PREFIX, 'title'))?.focus();
        }
      });
    } catch {
      setActionError("Couldn't delete the event.");
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete() {
    if (!pendingUndo) return;
    await api.post(`${API}/timeline/${pendingUndo.id}/restore`);
    setPendingUndo(null);
    await load();
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <EmptyState icon="padlock" title="You don't have access to this campaign" />
      </div>
    );
  }

  const nextSortIndex = events.length ? Math.max(...events.map((e) => e.sortIndex)) + 10 : 10;

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 pb-20 md:pb-10" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <PageTitle>{t('nav.timeline')}</PageTitle>
        <div style={{ flex: 1 }} />
        {canDmWrite && !creating && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <DraftWithAiButton
              campaignId={cid}
              target="timeline_event"
              label="Draft with AI"
            />
            <Btn
              ref={newEventTriggerRef}
              onClick={() => {
                setNewDraft(emptyDraft(nextSortIndex));
                setNewFieldErrors({});
                setCreating(true);
                setActionError(null);
              }}
              style={{ fontSize: 13 }}
            >
              + New event
            </Btn>
          </div>
        )}
      </div>

      {actionError && <ErrorNote message={actionError} />}
      {error && <ErrorNote message={error} onRetry={load} />}

      {canDmWrite && visibilityEventId != null && (
        <VisibleToPlayersBar
          visible={!!events.find((e) => e.id === visibilityEventId && !e.hidden)}
          onHide={async () => {
            await api.patch<TimelineEvent>(`${API}/timeline/${visibilityEventId}`, { hidden: true });
            await load();
          }}
          onUndoHide={async () => {
            await api.patch<TimelineEvent>(`${API}/timeline/${visibilityEventId}`, { hidden: false });
            await load();
          }}
        />
      )}

      {/* Current in-world date */}
      {loading && !calendar ? (
        <Card density="compact" elev="sm">
          <Skeleton lines={2} />
        </Card>
      ) : (
        <Card density="compact" elev="sm">
          {editingCalendar ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {calConflict && (
                <StaleWriteConflict
                  base={calConflict.base}
                  mine={calDraft}
                  theirs={calConflict.theirs}
                  fields={CALENDAR_CONFLICT_FIELDS}
                  onResolve={(key, value) => setCalDraft((draft) => ({ ...draft, [key]: value }))}
                  onReloadAll={() => { setCalDraft(calConflict.theirs); setCalBase(calConflict.theirs); setCalConflict(null); }}
                />
              )}
              <label htmlFor="timeline-calendar-current-date" className="text-muted" style={{ fontSize: 11 }}>
                Current in-world date
              </label>
              <TextInput
                id="timeline-calendar-current-date"
                value={calDraft.currentDate}
                placeholder="e.g. 3rd of Flamerule, 1492 DR"
                aria-describedby="timeline-calendar-current-date-help"
                onChange={(ev) => setCalDraft((d) => ({ ...d, currentDate: ev.target.value }))}
              />
              <p id="timeline-calendar-current-date-help" className="text-muted" style={{ margin: 0, fontSize: 11 }}>
                Free-text “today” for the table (any calendar format).
              </p>
              <label htmlFor="timeline-calendar-note" className="text-muted" style={{ fontSize: 11 }}>
                Calendar note (markdown, optional)
              </label>
              <TextArea
                id="timeline-calendar-note"
                rows={3}
                value={calDraft.note}
                placeholder="Month names, moon phases, holy days…"
                onChange={(ev) => setCalDraft((d) => ({ ...d, note: ev.target.value }))}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn onClick={saveCalendar} disabled={busy}>{calConflict ? 'Save resolution' : 'Save'}</Btn>
                <Btn
                  ghost
                  onClick={() => {
                    restoreCalendarFocusRef.current = true;
                    setEditingCalendar(false);
                  }}
                  disabled={busy}
                >
                  Cancel
                </Btn>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <h2
                  className="text-muted"
                  style={{ margin: 0, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}
                >
                  Current in-world date
                </h2>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 500, marginTop: 2 }}>
                  {calendar?.currentDate || <span className="text-muted" style={{ fontStyle: 'italic', fontWeight: 400 }}>Not set</span>}
                </div>
                {calendar?.note && (
                  <div style={{ marginTop: 8 }}>
                    <Markdown>{calendar.note}</Markdown>
                  </div>
                )}
              </div>
              {canDmWrite && (
                <Btn
                  ref={calendarEditTriggerRef}
                  ghost
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    setCalDraft({ currentDate: calendar?.currentDate ?? '', note: calendar?.note ?? '' });
                    setCalBase({ currentDate: calendar?.currentDate ?? '', note: calendar?.note ?? '' });
                    setCalExpected(calendar?.updatedAt ?? null);
                    setCalConflict(null);
                    setEditingCalendar(true);
                    setActionError(null);
                  }}
                >
                  Edit
                </Btn>
              )}
            </div>
          )}
          {isDm && calendar && !editingCalendar && (
            <div className="mt-3">
              <RevisionHistoryPanel
                entityType="timeline_calendar"
                entityId={cid}
                currentSnapshot={{ note: calendar.note }}
                expectedUpdatedAt={calendar.updatedAt}
                reloadNonce={historyNonce}
                onRestored={() => { setHistoryNonce((value) => value + 1); void load(); }}
                label="Calendar note history"
              />
            </div>
          )}
        </Card>
      )}

      {/* New event form */}
      {canDmWrite && creating && (
        <Card density="compact" elev="sm" data-testid="timeline-event-create-form">
          <EventForm
            idPrefix={TIMELINE_NEW_FORM_PREFIX}
            draft={newDraft}
            setDraft={setNewDraft}
            fieldErrors={newFieldErrors}
            onClearFieldError={(field) => setNewFieldErrors((fe) => ({ ...fe, [field]: undefined }))}
            createAudience={createAudience}
            onCreateAudienceChange={setCreateAudience}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn onClick={createEvent} disabled={busy}>Create event</Btn>
            <Btn
              ghost
              onClick={() => {
                setNewFieldErrors({});
                setCreateAudience('dm');
                restoreNewEventFocusRef.current = true;
                setCreating(false);
              }}
              disabled={busy}
            >
              Cancel
            </Btn>
          </div>
        </Card>
      )}

      {/* Event list */}
      {loading && !events.length ? (
        <Card density="compact" elev="sm">
          <Skeleton lines={5} />
        </Card>
      ) : events.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="No timeline events yet"
          hint={isDm ? 'Chart your world’s history with "+ New event".' : 'The DM hasn’t charted any history yet.'}
        />
      ) : (
        <ol style={{ display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', margin: 0, padding: 0 }}>
          {events.map((e) => (
            <Card key={e.id} density="compact" elev="sm" as="li" {...entityTargetProps('timeline', e.id)}>
              {editingId === e.id ? (
                <div data-testid="timeline-event-edit-form">
                  {eventConflict && (
                    <div className="mb-3">
                      <StaleWriteConflict
                        base={eventConflict.base}
                        mine={editDraft}
                        theirs={eventConflict.theirs}
                        fields={EVENT_CONFLICT_FIELDS}
                        onResolve={(key, value) => setEditDraft((draft) => ({ ...draft, [key]: value }))}
                        onReloadAll={() => { setEditDraft(eventConflict.theirs); setEditBase(eventConflict.theirs); setEventConflict(null); }}
                      />
                    </div>
                  )}
                  <EventForm
                    idPrefix={TIMELINE_EDIT_FORM_PREFIX}
                    draft={editDraft}
                    setDraft={setEditDraft}
                    fieldErrors={editFieldErrors}
                    onClearFieldError={(field) => setEditFieldErrors((fe) => ({ ...fe, [field]: undefined }))}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                    <Btn onClick={() => saveEdit(e.id)} disabled={busy}>{eventConflict ? 'Save resolution' : 'Save'}</Btn>
                    <DraftWithAiButton
                      campaignId={cid}
                      target="timeline_event"
                      label="Edit with AI"
                      entityId={e.id}
                      currentContent={{ title: editDraft.title, prose: editDraft.body }}
                      disabled={busy}
                    />
                    <Btn
                      ghost
                      onClick={() => {
                        setEditFieldErrors({});
                        restoreEditFocusIdRef.current = e.id;
                        setEditingId(null);
                      }}
                      disabled={busy}
                    >
                      Cancel
                    </Btn>
                    <div style={{ flex: 1 }} />
                    <Btn
                      ref={deleteTriggerRef}
                      danger
                      ghost
                      onClick={() => setConfirmingDelete({ id: e.id, title: e.title })}
                      busy={deleting}
                      disabled={busy || deleting}
                    >
                      Delete
                    </Btn>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {e.inWorldDate && (
                        <span className="tag tag-accent" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>{e.inWorldDate}</span>
                      )}
                      {e.era && <span className="tag tag-outline" style={{ fontSize: 10 }}>{e.era}</span>}
                      {isDm && e.hidden && (
                        <span className="tag tag-outline" style={{ fontSize: 10 }} title="Hidden from players"><GameIcon slug="sight-disabled" size={UI_ICON_SIZE.xs} className="inline align-text-bottom mr-1" />Hidden</span>
                      )}
                    </div>
                    <h2
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 500,
                        fontSize: 16,
                        margin: '4px 0 0',
                        color: 'var(--color-text)',
                      }}
                    >
                      {e.title}
                    </h2>
                    {e.body && (
                      <div style={{ marginTop: 6 }}>
                        <Markdown>{e.body}</Markdown>
                      </div>
                    )}
                    {isDm && e.dmSecret && (
                      <div style={{ marginTop: 8 }}>
                        <DmPanel>
                          <Markdown>{e.dmSecret}</Markdown>
                        </DmPanel>
                      </div>
                    )}
                  </div>
                  {canDmWrite && (
                    <Btn
                      ref={(node) => {
                        if (node) editTriggerRefs.current.set(e.id, node);
                        else editTriggerRefs.current.delete(e.id);
                      }}
                      ghost
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        setEditDraft(draftFrom(e));
                        setEditBase(draftFrom(e));
                        setEditExpected(e.updatedAt);
                        setEventConflict(null);
                        setEditFieldErrors({});
                        setEditingId(e.id);
                        // #754: track the edited event for the "Visible to players"
                        // bar so it isn't limited to events created this session.
                        // Set unconditionally (even when hidden): the bar's `visible`
                        // guard renders nothing while the event stays hidden, and
                        // keeping it mounted means revealing the event mid-edit shows
                        // the bar without needing a fresh create/edit cycle.
                        setVisibilityEventId(e.id);
                        setActionError(null);
                      }}
                    >
                      Edit
                    </Btn>
                  )}
                </div>
              )}
              {isDm && editingId !== e.id && (
                <div className="mt-3">
                  <RevisionHistoryPanel
                    entityType="timeline_event"
                    entityId={e.id}
                    currentSnapshot={{ body: e.body }}
                    expectedUpdatedAt={e.updatedAt}
                    reloadNonce={historyNonce}
                    onRestored={() => { setHistoryNonce((value) => value + 1); void load(); }}
                    label="Event description history"
                  />
                </div>
              )}
            </Card>
          ))}
        </ol>
      )}

      {events.length > 0 && (
        <p className="text-muted" style={{ margin: 0, fontSize: 11 }} aria-live="polite">
          {loading
            ? 'Loading…'
            : hasMore || total > events.length
              ? `Showing ${events.length} of ${total} events`
              : `Showing all ${events.length} events`}
        </p>
      )}

      {hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Btn
            type="button"
            ghost
            style={{ fontSize: 12 }}
            disabled={loadingMore || loading}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Btn>
        </div>
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete ${confirmingDelete.title}?`}
          body="This moves the event to the Trash — you can undo it right away, or restore it later from the campaign Trash."
          confirmLabel="Delete event"
          busy={deleting}
          onConfirm={() => removeEvent(confirmingDelete.id)}
          onCancel={() => {
            setConfirmingDelete(null);
            requestAnimationFrame(() => deleteTriggerRef.current?.focus());
          }}
        />
      )}

      {pendingUndo && (
        <UndoSnackbar
          message={`${pendingUndo.title} moved to the Trash.`}
          onUndo={undoDelete}
          onExpire={() => setPendingUndo(null)}
        />
      )}
    </div>
  );
}

function EventForm({
  idPrefix,
  draft,
  setDraft,
  fieldErrors,
  onClearFieldError,
  createAudience,
  onCreateAudienceChange,
}: {
  idPrefix: string;
  draft: EventDraft;
  setDraft: Dispatch<SetStateAction<EventDraft>>;
  fieldErrors: TimelineEventFieldErrors;
  onClearFieldError: (field: 'title' | 'order') => void;
  /** When set, this is a create form — Audience replaces the hidden checkbox (#754). */
  createAudience?: AudienceValue;
  onCreateAudienceChange?: (next: AudienceValue) => void;
}) {
  const isCreate = createAudience != null && onCreateAudienceChange != null;
  const titleId = timelineFieldId(idPrefix, 'title');
  const titleErrorId = timelineFieldErrorId(idPrefix, 'title');
  const dateId = timelineFieldId(idPrefix, 'inWorldDate');
  const dateHelpId = timelineFieldHelpId(idPrefix, 'inWorldDate');
  const eraId = timelineFieldId(idPrefix, 'era');
  const orderId = timelineFieldId(idPrefix, 'order');
  const orderHelpId = timelineFieldHelpId(idPrefix, 'order');
  const orderErrorId = timelineFieldErrorId(idPrefix, 'order');
  const bodyId = timelineFieldId(idPrefix, 'body');
  const bodyHelpId = timelineFieldHelpId(idPrefix, 'body');
  const dmSecretId = timelineFieldId(idPrefix, 'dmSecret');
  const dmSecretHelpId = timelineFieldHelpId(idPrefix, 'dmSecret');
  const hiddenId = timelineFieldId(idPrefix, 'hidden');

  const orderDescribedBy = [orderHelpId, fieldErrors.order ? orderErrorId : null].filter(Boolean).join(' ');
  const titleDescribedBy = fieldErrors.title ? titleErrorId : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label htmlFor={titleId} className="text-muted" style={{ fontSize: 11 }}>Title</label>
      <TextInput
        id={titleId}
        value={draft.title}
        placeholder="e.g. The Sundering"
        aria-invalid={fieldErrors.title ? true : undefined}
        aria-describedby={titleDescribedBy}
        onChange={(e) => {
          setDraft((d) => ({ ...d, title: e.target.value }));
          if (fieldErrors.title) onClearFieldError('title');
        }}
      />
      {fieldErrors.title && (
        <p id={titleErrorId} role="alert" className="text-muted" style={{ margin: 0, fontSize: 11, color: 'var(--color-danger, #f87171)' }}>
          {fieldErrors.title}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label htmlFor={dateId} className="text-muted" style={{ fontSize: 11 }}>In-world date</label>
          <TextInput
            id={dateId}
            value={draft.inWorldDate}
            placeholder="3rd of Flamerule, 1492 DR"
            aria-describedby={dateHelpId}
            onChange={(e) => setDraft((d) => ({ ...d, inWorldDate: e.target.value }))}
          />
          <p id={dateHelpId} className="text-muted" style={{ margin: '4px 0 0', fontSize: 11 }}>
            {TIMELINE_DATE_HELP}
          </p>
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label htmlFor={eraId} className="text-muted" style={{ fontSize: 11 }}>Era (optional)</label>
          <TextInput
            id={eraId}
            value={draft.era}
            placeholder="Age of Chains"
            onChange={(e) => setDraft((d) => ({ ...d, era: e.target.value }))}
          />
        </div>
        <div style={{ flex: '0 1 110px' }}>
          <label htmlFor={orderId} className="text-muted" style={{ fontSize: 11 }}>{TIMELINE_ORDER_LABEL}</label>
          <TextInput
            id={orderId}
            type="number"
            inputMode="numeric"
            value={draft.sortIndex}
            aria-invalid={fieldErrors.order ? true : undefined}
            aria-describedby={orderDescribedBy}
            onChange={(e) => {
              setDraft((d) => ({ ...d, sortIndex: e.target.value }));
              if (fieldErrors.order) onClearFieldError('order');
            }}
          />
          <p id={orderHelpId} className="text-muted" style={{ margin: '4px 0 0', fontSize: 11 }}>
            {TIMELINE_ORDER_HELP}
          </p>
          {fieldErrors.order && (
            <p id={orderErrorId} role="alert" className="text-muted" style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--color-danger, #f87171)' }}>
              {fieldErrors.order}
            </p>
          )}
        </div>
      </div>
      <label htmlFor={bodyId} className="text-muted" style={{ fontSize: 11 }}>
        {TIMELINE_BODY_LABEL} (markdown, optional)
      </label>
      <TextArea
        id={bodyId}
        rows={3}
        value={draft.body}
        aria-describedby={bodyHelpId}
        onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
      />
      <p id={bodyHelpId} className="text-muted" style={{ margin: 0, fontSize: 11 }}>
        {TIMELINE_BODY_HELP}
      </p>
      <label htmlFor={dmSecretId} className="text-muted" style={{ fontSize: 11 }}>
        {TIMELINE_DM_SECRET_LABEL}
      </label>
      <TextArea
        id={dmSecretId}
        rows={2}
        value={draft.dmSecret}
        aria-describedby={dmSecretHelpId}
        onChange={(e) => setDraft((d) => ({ ...d, dmSecret: e.target.value }))}
      />
      <p id={dmSecretHelpId} className="text-muted" style={{ margin: 0, fontSize: 11 }}>
        {TIMELINE_DM_SECRET_HELP}
      </p>
      {isCreate ? (
        <AudienceField
          value={createAudience}
          onChange={onCreateAudienceChange}
          entityLabel="timeline event"
          name="timeline-audience"
        />
      ) : (
        <label htmlFor={hiddenId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            id={hiddenId}
            type="checkbox"
            checked={draft.hidden}
            onChange={(e) => setDraft((d) => ({ ...d, hidden: e.target.checked }))}
          />
          Hidden from players (prep)
        </label>
      )}
    </div>
  );
}
