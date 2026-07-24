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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { TimelineEvent, TimelineCalendar } from '@campfire/schema';
import { api, API, ApiError, isStaleWrite } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Markdown } from '../../components/Markdown';
import { Skeleton, ErrorNote, EmptyState, Btn, TextInput, TextArea, DmPanel } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { entityTargetProps } from '../../lib/entityLinks';
import { StaleWriteConflict, type ConflictField } from '../../components/StaleWriteConflict';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';

interface EventDraft {
  title: string;
  inWorldDate: string;
  era: string;
  sortIndex: string;
  body: string;
  dmSecret: string;
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
  const [calBase, setCalBase] = useState<CalendarDraft | null>(null);
  const [calExpected, setCalExpected] = useState<string | null>(null);
  const [calConflict, setCalConflict] = useState<{ base: CalendarDraft; theirs: CalendarDraft } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<EventDraft>(emptyDraft());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<EventDraft>(emptyDraft());
  const [editBase, setEditBase] = useState<EventDraft | null>(null);
  const [editExpected, setEditExpected] = useState<string | null>(null);
  const [eventConflict, setEventConflict] = useState<{ base: EventDraft; theirs: EventDraft } | null>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const [cal, list] = await Promise.all([
        api.get<TimelineCalendar>(`${API}/campaigns/${cid}/timeline/calendar`),
        api.get<TimelineEvent[]>(`${API}/campaigns/${cid}/timeline`),
      ]);
      if (sequence !== loadSequence.current) return;
      setCalendar(cal);
      setEvents(list);
    } catch (e) {
      if (sequence === loadSequence.current) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setForbidden(true);
        else setError("Couldn't load the timeline.");
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

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
    if (!newDraft.title.trim()) {
      setActionError('An event needs a title.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.post<TimelineEvent>(`${API}/campaigns/${cid}/timeline`, draftToPayload(newDraft));
      setCreating(false);
      setNewDraft(emptyDraft());
      await load();
    } catch {
      setActionError("Couldn't create the event.");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (id: number) => {
    if (!editDraft.title.trim()) {
      setActionError('An event needs a title.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.patch<TimelineEvent>(`${API}/timeline/${id}`, { ...draftToPayload(editDraft), expectedUpdatedAt: editExpected ?? undefined });
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
      } else setActionError("Couldn't save the event.");
    } finally {
      setBusy(false);
    }
  };

  const deleteEvent = async (id: number) => {
    setBusy(true);
    setActionError(null);
    try {
      await api.delete(`${API}/timeline/${id}`);
      setEditingId(null);
      await load();
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
            onClick={() => {
              setNewDraft(emptyDraft(nextSortIndex));
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
              <label className="text-muted" style={{ fontSize: 11 }}>Current in-world date</label>
              <TextInput
                value={calDraft.currentDate}
                placeholder="e.g. 3rd of Flamerule, 1492 DR"
                onChange={(ev) => setCalDraft((d) => ({ ...d, currentDate: ev.target.value }))}
              />
              <label className="text-muted" style={{ fontSize: 11 }}>Calendar note (markdown, optional)</label>
              <TextArea
                rows={3}
                value={calDraft.note}
                placeholder="Month names, moon phases, holy days…"
                onChange={(ev) => setCalDraft((d) => ({ ...d, note: ev.target.value }))}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn onClick={saveCalendar} disabled={busy}>{calConflict ? 'Save resolution' : 'Save'}</Btn>
                <Btn ghost onClick={() => setEditingCalendar(false)} disabled={busy}>Cancel</Btn>
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
                reloadNonce={historyNonce}
                onRestored={() => { setHistoryNonce((value) => value + 1); void load(); }}
                label="Calendar note history"
              />
            </div>
          )}
        </div>
      )}

      {/* New event form */}
      {isDm && creating && (
        <div className="card elev-sm">
          <EventForm draft={newDraft} setDraft={setNewDraft} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn onClick={createEvent} disabled={busy}>Create event</Btn>
            <Btn ghost onClick={() => setCreating(false)} disabled={busy}>Cancel</Btn>
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
                <div>
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
                  <EventForm draft={editDraft} setDraft={setEditDraft} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <Btn onClick={() => saveEdit(e.id)} disabled={busy}>{eventConflict ? 'Save resolution' : 'Save'}</Btn>
                    <Btn ghost onClick={() => setEditingId(null)} disabled={busy}>Cancel</Btn>
                    <div style={{ flex: 1 }} />
                    <Btn danger ghost onClick={() => deleteEvent(e.id)} disabled={busy}>Delete</Btn>
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
                      ghost
                      style={{ fontSize: 12 }}
                      onClick={() => {
                        setEditDraft(draftFrom(e));
                        setEditBase(draftFrom(e));
                        setEditExpected(e.updatedAt);
                        setEventConflict(null);
                        setEditingId(e.id);
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
                    reloadNonce={historyNonce}
                    onRestored={() => { setHistoryNonce((value) => value + 1); void load(); }}
                    label="Event description history"
                  />
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EventForm({ draft, setDraft }: { draft: EventDraft; setDraft: (updater: (d: EventDraft) => EventDraft) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label className="text-muted" style={{ fontSize: 11 }}>Title</label>
      <TextInput
        value={draft.title}
        placeholder="e.g. The Sundering"
        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label className="text-muted" style={{ fontSize: 11 }}>In-world date</label>
          <TextInput
            value={draft.inWorldDate}
            placeholder="3rd of Flamerule, 1492 DR"
            onChange={(e) => setDraft((d) => ({ ...d, inWorldDate: e.target.value }))}
          />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label className="text-muted" style={{ fontSize: 11 }}>Era (optional)</label>
          <TextInput
            value={draft.era}
            placeholder="Age of Chains"
            onChange={(e) => setDraft((d) => ({ ...d, era: e.target.value }))}
          />
        </div>
        <div style={{ flex: '0 1 110px' }}>
          <label className="text-muted" style={{ fontSize: 11 }}>Order</label>
          <TextInput
            type="number"
            value={draft.sortIndex}
            onChange={(e) => setDraft((d) => ({ ...d, sortIndex: e.target.value }))}
          />
        </div>
      </div>
      <label className="text-muted" style={{ fontSize: 11 }}>Description (markdown, optional)</label>
      <TextArea
        rows={3}
        value={draft.body}
        onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
      />
      <label className="text-muted" style={{ fontSize: 11 }}>DM secret (players never see this)</label>
      <TextArea
        rows={2}
        value={draft.dmSecret}
        onChange={(e) => setDraft((d) => ({ ...d, dmSecret: e.target.value }))}
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input
          type="checkbox"
          checked={draft.hidden}
          onChange={(e) => setDraft((d) => ({ ...d, hidden: e.target.checked }))}
        />
        Hidden from players (prep)
      </label>
    </div>
  );
}
