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
import { useParams } from 'react-router-dom';
import type { TimelineEvent, TimelineCalendar } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Markdown } from '../../components/Markdown';
import { Skeleton, ErrorNote, EmptyState, Btn, TextInput, TextArea, DmPanel } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
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

interface EventDraft {
  title: string;
  inWorldDate: string;
  era: string;
  sortIndex: string;
  body: string;
  dmSecret: string;
  hidden: boolean;
}

function emptyDraft(sortIndex = 0): EventDraft {
  return { title: '', inWorldDate: '', era: '', sortIndex: String(sortIndex), body: '', dmSecret: '', hidden: false };
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
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { roleIn } = useAuth();
  const isDm = roleIn(cid) === 'dm';

  const [calendar, setCalendar] = useState<TimelineCalendar | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // DM editing state
  const [editingCalendar, setEditingCalendar] = useState(false);
  const [calDraft, setCalDraft] = useState({ currentDate: '', note: '' });
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<EventDraft>(emptyDraft());
  const [newFieldErrors, setNewFieldErrors] = useState<TimelineEventFieldErrors>({});
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EventDraft>(emptyDraft());
  const [editFieldErrors, setEditFieldErrors] = useState<TimelineEventFieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const newEventTriggerRef = useRef<HTMLButtonElement>(null);
  const editTriggerRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const calendarEditTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreNewEventFocusRef = useRef(false);
  const restoreEditFocusIdRef = useRef<number | null>(null);
  const restoreCalendarFocusRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [cal, list] = await Promise.all([
        api.get<TimelineCalendar>(`${API}/campaigns/${cid}/timeline/calendar`),
        api.get<TimelineEvent[]>(`${API}/campaigns/${cid}/timeline`),
      ]);
      setCalendar(cal);
      setEvents(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setForbidden(true);
      else setError("Couldn't load the timeline.");
    } finally {
      setLoading(false);
    }
  }, [cid]);

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

  const saveCalendar = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const updated = await api.put<TimelineCalendar>(`${API}/campaigns/${cid}/timeline/calendar`, {
        currentDate: calDraft.currentDate.trim(),
        note: calDraft.note,
      });
      setCalendar(updated);
      restoreCalendarFocusRef.current = true;
      setEditingCalendar(false);
    } catch {
      setActionError("Couldn't save the current date.");
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
      await api.post<TimelineEvent>(`${API}/campaigns/${cid}/timeline`, draftToPayload(newDraft));
      setNewDraft(emptyDraft());
      setNewFieldErrors({});
      restoreNewEventFocusRef.current = true;
      setCreating(false);
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
      await api.patch<TimelineEvent>(`${API}/timeline/${id}`, draftToPayload(editDraft));
      setEditFieldErrors({});
      restoreEditFocusIdRef.current = id;
      setEditingId(null);
      await load();
    } catch {
      setActionError("Couldn't save the event.");
      focusField(timelineFieldId(TIMELINE_EDIT_FORM_PREFIX, 'title'));
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async (id: number) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.delete(`${API}/timeline/${id}`);
      setEditFieldErrors({});
      setEditingId(null);
      await load();
      // The deleted row's Edit trigger is gone. Prefer "+ New event" when it is
      // mounted; while creating=true that control is not rendered, so focus a
      // stable visible control in the open create form instead.
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
      setBusy(false);
    }
  };

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
        <h3 style={{ margin: '4px 0 0' }}>Timeline</h3>
        <div style={{ flex: 1 }} />
        {isDm && !creating && (
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
        )}
      </div>

      {actionError && <ErrorNote message={actionError} />}
      {error && <ErrorNote message={error} onRetry={load} />}

      {/* Current in-world date */}
      {loading && !calendar ? (
        <div className="card elev-sm">
          <Skeleton lines={2} />
        </div>
      ) : (
        <div className="card elev-sm">
          {editingCalendar ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                <Btn onClick={saveCalendar} disabled={busy}>Save</Btn>
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
                <div className="text-muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Current in-world date
                </div>
                <div style={{ fontFamily: 'var(--font-heading)', fontSize: 18, fontWeight: 500, marginTop: 2 }}>
                  {calendar?.currentDate || <span className="text-muted" style={{ fontStyle: 'italic', fontWeight: 400 }}>Not set</span>}
                </div>
                {calendar?.note && (
                  <div style={{ marginTop: 8 }}>
                    <Markdown>{calendar.note}</Markdown>
                  </div>
                )}
              </div>
              {isDm && (
                <Btn
                  ref={calendarEditTriggerRef}
                  ghost
                  style={{ fontSize: 12 }}
                  onClick={() => {
                    setCalDraft({ currentDate: calendar?.currentDate ?? '', note: calendar?.note ?? '' });
                    setEditingCalendar(true);
                    setActionError(null);
                  }}
                >
                  Edit
                </Btn>
              )}
            </div>
          )}
        </div>
      )}

      {/* New event form */}
      {isDm && creating && (
        <div className="card elev-sm" data-testid="timeline-event-create-form">
          <EventForm
            idPrefix={TIMELINE_NEW_FORM_PREFIX}
            draft={newDraft}
            setDraft={setNewDraft}
            fieldErrors={newFieldErrors}
            onClearFieldError={(field) => setNewFieldErrors((fe) => ({ ...fe, [field]: undefined }))}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn onClick={createEvent} disabled={busy}>Create event</Btn>
            <Btn
              ghost
              onClick={() => {
                setNewFieldErrors({});
                restoreNewEventFocusRef.current = true;
                setCreating(false);
              }}
              disabled={busy}
            >
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {/* Event list */}
      {loading && !events.length ? (
        <div className="card elev-sm">
          <Skeleton lines={5} />
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="No timeline events yet"
          hint={isDm ? 'Chart your world’s history with "+ New event".' : 'The DM hasn’t charted any history yet.'}
        />
      ) : (
        <ol style={{ display: 'flex', flexDirection: 'column', gap: 10, listStyle: 'none', margin: 0, padding: 0 }}>
          {events.map((e) => (
            <li key={e.id} className="card elev-sm" {...entityTargetProps('timeline', e.id)}>
              {editingId === e.id ? (
                <div data-testid="timeline-event-edit-form">
                  <EventForm
                    idPrefix={TIMELINE_EDIT_FORM_PREFIX}
                    draft={editDraft}
                    setDraft={setEditDraft}
                    fieldErrors={editFieldErrors}
                    onClearFieldError={(field) => setEditFieldErrors((fe) => ({ ...fe, [field]: undefined }))}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <Btn onClick={() => saveEdit(e.id)} disabled={busy}>Save</Btn>
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
                    <Btn danger ghost onClick={() => deleteEvent(e.id)} busy={busy}>Delete</Btn>
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
                        <span className="tag tag-outline" style={{ fontSize: 10 }} title="Hidden from players"><GameIcon slug="sight-disabled" size={11} className="inline align-text-bottom mr-1" />Hidden</span>
                      )}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-heading)',
                        fontWeight: 500,
                        fontSize: 16,
                        marginTop: 4,
                        color: 'var(--color-text)',
                      }}
                    >
                      {e.title}
                    </div>
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
                  {isDm && (
                    <Btn
                      ref={(node) => {
                        if (node) editTriggerRefs.current.set(e.id, node);
                        else editTriggerRefs.current.delete(e.id);
                      }}
                      ghost
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        setEditDraft(draftFrom(e));
                        setEditFieldErrors({});
                        setEditingId(e.id);
                        setActionError(null);
                      }}
                    >
                      Edit
                    </Btn>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
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
}: {
  idPrefix: string;
  draft: EventDraft;
  setDraft: Dispatch<SetStateAction<EventDraft>>;
  fieldErrors: TimelineEventFieldErrors;
  onClearFieldError: (field: 'title' | 'order') => void;
}) {
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
      <label htmlFor={hiddenId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          id={hiddenId}
          type="checkbox"
          checked={draft.hidden}
          onChange={(e) => setDraft((d) => ({ ...d, hidden: e.target.checked }))}
        />
        Hidden from players (prep)
      </label>
    </div>
  );
}
