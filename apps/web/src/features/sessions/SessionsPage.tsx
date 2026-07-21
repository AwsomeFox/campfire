/**
 * Session log — mirrors design/claude-design/Campfire.dc.html "Session log" (~867-942) and
 * "Session detail" (~1059-1073).
 * Route: /c/:campaignId/sessions ; optional ?session=:id selects the detail pane.
 * Two-pane desktop layout; mobile shows list OR detail (tap in, back out). The timeline
 * uses the design's left-rule + dot marker per entry.
 *
 * Design shows "Encounters" and "Rolls" tabs alongside the log — the design itself marks
 * Encounters "Proposed · post-v1" and there is no dice/roll or encounter API on the server,
 * so only the Log tab (the MVP scope) is implemented here. See report for details.
 *
 * Issue #13 adds a "Schedule" tab (?tab=schedule): planned sessions + availability + ICS
 * calendar feed — see SchedulePanel.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Session, SessionListItem, SessionShare, SessionShareCreated, SessionAttendee, Character, EntityRevision } from '@campfire/schema';
import { RECAP_TEMPLATE } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { formatDate as formatLocaleDate } from '../../lib/format';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { SchedulePanel } from './SchedulePanel';
import { CommentsThread } from '../comments/CommentsThread';

export default function SessionsPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';

  const selectedId = searchParams.get('session');
  const tab: 'log' | 'schedule' = searchParams.get('tab') === 'schedule' ? 'schedule' : 'log';

  function setTab(next: 'log' | 'schedule') {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === 'schedule') params.set('tab', 'schedule');
      else params.delete('tab');
      return params;
    });
  }

  // List-shape sessions (issue #71): each carries a `recapExcerpt`, not the full
  // recap body — SessionDetail fetches the full recap for the opened session.
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [showAddForm, setShowAddForm] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const list = await api.get<SessionListItem[]>(`${API}/campaigns/${cid}/sessions`);
      setSessions(list);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError("Couldn't load sessions.");
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  useEffect(() => {
    if (Number.isFinite(cid)) void load();
  }, [cid, load]);

  const selected = useMemo(
    () => (selectedId ? sessions.find((s) => String(s.id) === selectedId) : undefined),
    [sessions, selectedId],
  );

  // Auto-open the latest recap when sessions exist but none is selected (or the
  // URL points at a session that's gone) — otherwise the detail pane sat on a
  // misleading "No sessions yet" empty state even with sessions in the list.
  useEffect(() => {
    if (tab === 'log' && sessions.length > 0 && !selected) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('session', String(sessions[0].id));
          return next;
        },
        { replace: true },
      );
    }
  }, [tab, sessions, selected, setSearchParams]);

  function selectSession(id: number) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('session', String(id));
      return next;
    });
  }

  function backToList() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('session');
      return next;
    });
  }

  function nextNumber() {
    return sessions.reduce((max, s) => Math.max(max, s.number), 0) + 1;
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message="No campaign selected." />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="🔒" title="You don't have access to this campaign" />
        </Card>
      </div>
    );
  }

  if (loading && sessions.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4">
        <Card>
          <Skeleton lines={4} />
        </Card>
      </div>
    );
  }

  if (error && sessions.length === 0) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  const showDetailOnMobile = Boolean(selected);

  return (
    <div className="max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="flex items-center gap-2.5">
        <h1 className="text-2xl font-extrabold text-white">Sessions</h1>
        <div className="flex-1" />
        {isDm && tab === 'log' && (
          <Btn
            className="!min-h-0 !py-1.5 text-xs"
            onClick={() => {
              setShowAddForm(true);
              if (selected) backToList();
            }}
          >
            + Add recap
          </Btn>
        )}
      </div>

      <div className="seg self-start inline-flex">
        {(['log', 'schedule'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '8px 16px',
              fontSize: 13,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              color: tab === t ? 'var(--color-accent)' : 'var(--color-neutral-500)',
              boxShadow: tab === t ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
              minHeight: 40,
            }}
          >
            {t === 'log' ? 'Log' : 'Schedule'}
          </button>
        ))}
      </div>

      {tab === 'schedule' ? (
        <SchedulePanel campaignId={cid} isDm={isDm} />
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Timeline list */}
        <aside className={`min-w-0 ${showDetailOnMobile ? 'hidden lg:block' : ''}`}>
          {sessions.length === 0 && !showAddForm ? (
            <Card>
              <EmptyState title="No sessions yet — add your first recap" />
            </Card>
          ) : (
            <div className="flex flex-col">
              {sessions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  className="text-left"
                  style={{
                    display: 'flex',
                    gap: 14,
                    border: 0,
                    background: 'transparent',
                    font: 'inherit',
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    padding: '14px 0 14px 16px',
                    borderLeft: `2px solid ${selected?.id === s.id ? 'var(--color-accent)' : 'var(--color-accent-800)'}`,
                    position: 'relative',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      left: -5,
                      top: 20,
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: selected?.id === s.id ? 'var(--color-accent)' : 'var(--color-accent-800)',
                    }}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex gap-2.5 items-baseline flex-wrap">
                      <span className="text-xs whitespace-nowrap" style={{ color: 'var(--color-accent)' }}>
                        Session {s.number}
                      </span>
                      <span className="font-heading text-[16px]">{s.title || 'Untitled session'}</span>
                      <span className="text-muted text-[11.5px] ml-auto">{formatDate(s.playedAt)}</span>
                    </span>
                    <span className="text-muted text-[13px] block mt-1 line-clamp-2">{s.recapExcerpt || 'No recap written yet.'}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Recap detail */}
        <main className={`min-w-0 lg:col-span-2 space-y-4 ${showDetailOnMobile ? '' : 'hidden lg:block'}`}>
          {selected ? (
            <SessionDetail session={selected} campaignId={cid} isDm={isDm} onBack={backToList} onChange={load} />
          ) : (
            <Card>
              {sessions.length > 0 ? (
                <EmptyState icon="📖" title="Select a session" hint="Pick a recap from the timeline on the left." />
              ) : (
                <EmptyState title="No sessions yet — add your first recap" hint="Use “+ Add recap” to log your first session." />
              )}
            </Card>
          )}

          {isDm && (showAddForm || sessions.length === 0) && (
            <AddRecapForm
              campaignId={cid}
              nextNumber={nextNumber()}
              onCreated={(created) => {
                setShowAddForm(false);
                selectSession(created.id);
                void load();
              }}
              onCancel={sessions.length > 0 ? () => setShowAddForm(false) : undefined}
            />
          )}
        </main>
      </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionDetail({
  session,
  campaignId,
  isDm,
  onBack,
  onChange,
}: {
  session: SessionListItem;
  campaignId: number;
  isDm: boolean;
  onBack: () => void;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(session.title);
  const [dateDraft, setDateDraft] = useState(toDateInputValue(session.playedAt));
  // The list omits the full recap body (issue #71) — fetch it for the opened session.
  const [recap, setRecap] = useState('');
  const [recapLoading, setRecapLoading] = useState(true);
  const [recapDraft, setRecapDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pendingUndo, setPendingUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The `updatedAt` we last loaded — sent back on save as the optimistic-concurrency
  // guard (#157) so a co-DM's or a connected AI's interleaved edit 409s instead of being
  // silently clobbered. Bumped to null on a stale-conflict so the user must reload first.
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Bumped after a save/restore to tell the history panel to refetch.
  const [historyNonce, setHistoryNonce] = useState(0);

  useEffect(() => {
    setEditing(false);
    setSharing(false);
    setTitleDraft(session.title);
    setDateDraft(toDateInputValue(session.playedAt));
    setRecapLoading(true);
    let cancelled = false;
    api
      .get<Session>(`${API}/sessions/${session.id}`)
      .then((full) => {
        if (cancelled) return;
        setRecap(full.recap);
        setRecapDraft(full.recap);
        setLoadedUpdatedAt(full.updatedAt);
        setConflict(false);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setRecapLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  async function save() {
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const updated = await api.patch<Session>(`${API}/sessions/${session.id}`, {
        title: titleDraft,
        playedAt: dateDraft ? dateDraft : null,
        recap: recapDraft,
        // Optimistic-concurrency guard (#157): echo back the updatedAt we loaded, so a
        // concurrent edit is caught (409) instead of overwriting the other author's work.
        ...(loadedUpdatedAt ? { expectedUpdatedAt: loadedUpdatedAt } : {}),
      });
      setRecap(updated.recap);
      setLoadedUpdatedAt(updated.updatedAt);
      setEditing(false);
      setHistoryNonce((n) => n + 1);
      onChange();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Someone saved between our load and this save — keep the user's draft intact,
        // stop them from clobbering, and prompt a reload of the latest version.
        setConflict(true);
        setError(
          e.message ||
            'This recap changed since you opened it — reload to see the latest version before saving, so you don\'t erase the other edit.',
        );
      } else {
        setError("Couldn't save the recap.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    setError(null);
    setConflict(false);
    setRecapLoading(true);
    try {
      const full = await api.get<Session>(`${API}/sessions/${session.id}`);
      setRecap(full.recap);
      setRecapDraft(full.recap);
      setLoadedUpdatedAt(full.updatedAt);
    } catch {
      setError("Couldn't reload the latest recap.");
    } finally {
      setRecapLoading(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      // Soft-delete (issue #116) — reversible. Keep the detail open with an Undo
      // affordance; defer the list refresh to expiry so the detail (and this Undo bar)
      // don't unmount mid-window (the list derives `selected` by id).
      await api.delete(`${API}/sessions/${session.id}`);
      setConfirmingDelete(false);
      setPendingUndo(true);
    } catch {
      setError("Couldn't delete the session.");
    } finally {
      setDeleting(false);
    }
  }

  async function undoDelete() {
    await api.post(`${API}/sessions/${session.id}/restore`);
    setPendingUndo(false);
    onChange();
  }

  return (
    <div className="space-y-3" style={{ maxWidth: 720 }}>
      <div>
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300 lg:hidden mb-1 block">
          ← Back to sessions
        </button>
      </div>
      {error && <ErrorNote message={error} />}
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <span className="tag tag-accent">Session {session.number}</span>
        <h2 className="text-xl font-extrabold text-white m-0">{session.title || 'Untitled session'}</h2>
        <span className="text-muted text-xs">{formatDate(session.playedAt)}</span>
      </div>

      {editing ? (
        <Card className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Title</label>
            <TextInput value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} placeholder="Session title…" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Played on</label>
            <TextInput type="date" value={dateDraft} onChange={(e) => setDateDraft(e.target.value)} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Recap</label>
              <div className="flex-1" />
              <TemplateButton value={recapDraft} onInsert={setRecapDraft} />
            </div>
            <TextArea
              style={{ minHeight: 200 }}
              value={recapDraft}
              onChange={(e) => setRecapDraft(e.target.value)}
              placeholder="What happened? Plain text is fine — # headings and - bullets render nicely."
            />
          </div>
          <div className="flex gap-2 justify-end items-center">
            {conflict && (
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={reloadLatest} disabled={saving}>
                Reload latest
              </Btn>
            )}
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </Card>
      ) : (
        <Card>
          {recapLoading ? (
            <p className="text-sm text-slate-600">Loading recap…</p>
          ) : recap ? (
            <Markdown>{recap}</Markdown>
          ) : (
            <p className="text-sm text-slate-600">No recap written yet.</p>
          )}
        </Card>
      )}

      {!editing && <AttendancePanel sessionId={session.id} campaignId={session.campaignId} isDm={isDm} />}

      {isDm && !editing && (
        <div className="flex gap-2">
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(true)}>
            Edit recap
          </Btn>
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setSharing((v) => !v)}>
            {sharing ? 'Hide sharing' : 'Share'}
          </Btn>
          <Btn danger ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setConfirmingDelete(true)} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Btn>
        </div>
      )}

      {isDm && !editing && sharing && <SharePanel sessionId={session.id} />}

      {/* Recap revision history + restore (issue #157) — DM-only, so a clobbered or
          regretted edit can be recovered. Refetches whenever a save/restore happens. */}
      {isDm && !editing && (
        <RecapHistoryPanel
          sessionId={session.id}
          reloadNonce={historyNonce}
          onRestored={() => {
            setHistoryNonce((n) => n + 1);
            void reloadLatest();
            onChange();
          }}
        />
      )}

      {confirmingDelete && (
        <ConfirmDialog
          title={`Delete Session ${session.number}?`}
          body="This moves the session (recap, attendance, share links) to the Trash — you can undo it, or restore it from the campaign Trash."
          confirmLabel={deleting ? 'Deleting…' : 'Delete session'}
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {pendingUndo && (
        <UndoSnackbar
          message={`Session ${session.number} moved to Trash.`}
          onUndo={undoDelete}
          onExpire={() => {
            onChange();
            onBack();
          }}
        />
      )}

      {/* Discussion thread on the recap (issue #123) — the shared, between-sessions
          surface: react to the recap, ask the DM, or post an in-character scene. */}
      <Card>
        <CommentsThread campaignId={campaignId} entityType="session" entityId={session.id} />
      </Card>
    </div>
  );
}

/**
 * Recap revision history + restore (issue #157). DM-only. Lists the prior-content
 * snapshots the server records on every committed recap change (newest first) and lets
 * the DM restore any of them — the restore is itself recorded, so it's reversible.
 * Collapsed by default so it doesn't crowd the recap; expands on demand.
 */
function RecapHistoryPanel({
  sessionId,
  reloadNonce,
  onRestored,
}: {
  sessionId: number;
  reloadNonce: number;
  onRestored: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<EntityRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api
      .get<EntityRevision[]>(`${API}/revisions/session/${sessionId}`)
      .then((rows) => {
        if (!cancelled) setRevisions(rows);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, reloadNonce]);

  async function restore(revisionId: number) {
    setRestoringId(revisionId);
    setError(null);
    try {
      const res = await api.post<{ revisions: EntityRevision[] }>(
        `${API}/revisions/session/${sessionId}/${revisionId}/restore`,
      );
      if (res?.revisions) setRevisions(res.revisions);
      onRestored();
    } catch {
      setError("Couldn't restore that version.");
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Card>
      <button
        className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase tracking-wide w-full"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>Recap history</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {error && <ErrorNote message={error} />}
          {loading ? (
            <p className="text-sm text-slate-600">Loading history…</p>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-slate-600">No earlier versions yet — edits are recorded here from now on.</p>
          ) : (
            revisions.map((rev) => {
              const prior = rev.snapshot.recap ?? '';
              const preview = prior.replace(/\s+/g, ' ').trim().slice(0, 120);
              return (
                <div key={rev.id} className="flex items-start gap-2 border-t border-slate-800 pt-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted">
                      {rev.authorName || 'Someone'} · {new Date(rev.createdAt).toLocaleString()}
                    </div>
                    <div className="text-[13px] text-slate-400 truncate">{preview || '(empty recap)'}</div>
                  </div>
                  <Btn
                    ghost
                    className="!min-h-0 !py-1 text-xs shrink-0"
                    onClick={() => restore(rev.id)}
                    disabled={restoringId !== null}
                  >
                    {restoringId === rev.id ? 'Restoring…' : 'Restore'}
                  </Btn>
                </div>
              );
            })
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Session attendance (issue #121) — the "who was there" record for a session.
 * Everyone sees the attendee chips; a DM gets a roster picker to toggle which
 * characters played (replace-set PUT). West Marches / rotating-cast tables need
 * this because the party is otherwise all-or-nothing.
 */
function AttendancePanel({ sessionId, campaignId, isDm }: { sessionId: number; campaignId: number; isDm: boolean }) {
  const [attendees, setAttendees] = useState<SessionAttendee[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [roster, setRoster] = useState<Character[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAttendees(await api.get<SessionAttendee[]>(`${API}/sessions/${sessionId}/attendance`));
    } catch {
      // Attendance is a non-critical embellishment on the recap — stay quiet on read failure.
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setEditing(false);
    void load();
  }, [load]);

  async function startEditing() {
    setError(null);
    if (!rosterLoaded) {
      try {
        setRoster(await api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`));
        setRosterLoaded(true);
      } catch {
        setError("Couldn't load the character roster.");
        return;
      }
    }
    setSelected(new Set(attendees.map((a) => a.characterId)));
    setEditing(true);
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.put<SessionAttendee[]>(`${API}/sessions/${sessionId}/attendance`, {
        characterIds: [...selected],
      });
      setAttendees(updated);
      setEditing(false);
    } catch {
      setError("Couldn't save attendance.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Who played</span>
        <div className="flex-1" />
        {isDm && !editing && (
          <Btn ghost className="!min-h-0 !py-1 text-xs" onClick={startEditing}>
            {attendees.length ? 'Edit' : 'Set attendance'}
          </Btn>
        )}
      </div>

      {error && <ErrorNote message={error} />}

      {editing ? (
        <div className="space-y-2">
          {roster.length === 0 ? (
            <p className="text-sm text-slate-600">No characters in this campaign yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {roster.map((c) => {
                const on = selected.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggle(c.id)}
                    className={on ? 'tag tag-accent' : 'tag'}
                    style={{ cursor: 'pointer', opacity: on ? 1 : 0.6 }}
                    aria-pressed={on}
                  >
                    {on ? '✓ ' : ''}
                    {c.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </div>
      ) : attendees.length ? (
        <div className="flex flex-wrap gap-1.5">
          {attendees.map((a) => (
            <span key={a.id} className="tag">
              {a.characterName || `Character ${a.characterId}`}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-600">Attendance not recorded.</p>
      )}
    </Card>
  );
}

/**
 * DM-only share-link management for one recap. The raw link is shown ONCE at
 * creation (the server stores only a hash) — after that the list shows the
 * display prefix, and the DM can revoke or mint a fresh link at any time.
 */
function SharePanel({ sessionId }: { sessionId: number }) {
  const [shares, setShares] = useState<SessionShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setShares(await api.get<SessionShare[]>(`${API}/sessions/${sessionId}/shares`));
    } catch {
      setError("Couldn't load share links.");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setNewLink(null);
    setCopied(false);
    void load();
  }, [load]);

  async function create() {
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await api.post<SessionShareCreated>(`${API}/sessions/${sessionId}/shares`);
      setNewLink(`${window.location.origin}/share/${res.token}`);
      await load();
    } catch {
      setError("Couldn't create a share link.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: number) {
    setRevokingId(id);
    setError(null);
    try {
      await api.delete(`${API}/sessions/${sessionId}/shares/${id}`);
      setNewLink(null);
      await load();
    } catch {
      setError("Couldn't revoke that link.");
    } finally {
      setRevokingId(null);
    }
  }

  async function copy() {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink);
      setCopied(true);
    } catch {
      /* clipboard unavailable — the link is selectable below */
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-bold text-white text-sm m-0">Read-only share links</h3>
        <div className="flex-1" />
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={create} disabled={creating}>
          {creating ? 'Creating…' : '+ New link'}
        </Btn>
      </div>
      <p className="text-[11.5px] text-slate-500 m-0">
        Anyone with a link can read this recap — no account needed. The full link is shown only once, so copy it now;
        revoke it here any time.
      </p>
      {error && <ErrorNote message={error} onRetry={load} />}

      {newLink && (
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-xs break-all flex-1 min-w-0" style={{ color: 'var(--color-accent)' }}>
            {newLink}
          </code>
          <Btn ghost className="!min-h-0 !py-1.5 text-xs shrink-0" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy link'}
          </Btn>
        </div>
      )}

      {loading ? (
        <Skeleton lines={2} />
      ) : shares.length === 0 ? (
        <p className="text-sm text-slate-600 m-0">No active links.</p>
      ) : (
        <ul className="m-0 p-0 space-y-1.5" style={{ listStyle: 'none' }}>
          {shares.map((s) => (
            <li key={s.id} className="flex items-center gap-2.5 text-xs">
              <code className="text-slate-400">{s.tokenPrefix}…</code>
              <span className="text-muted">created {formatDate(s.createdAt)}</span>
              <div className="flex-1" />
              <Btn danger ghost className="!min-h-0 !py-1 text-xs" onClick={() => revoke(s.id)} disabled={revokingId === s.id}>
                {revokingId === s.id ? 'Revoking…' : 'Revoke'}
              </Btn>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddRecapForm({
  campaignId,
  nextNumber,
  onCreated,
  onCancel,
}: {
  campaignId: number;
  nextNumber: number;
  onCreated: (session: Session) => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [playedAt, setPlayedAt] = useState(new Date().toISOString().slice(0, 10));
  const [recap, setRecap] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function publish() {
    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Session>(`${API}/campaigns/${campaignId}/sessions`, {
        number: nextNumber,
        title: title.trim(),
        playedAt: playedAt || null,
        recap,
      });
      setTitle('');
      setRecap('');
      onCreated(created);
    } catch {
      setError("Couldn't publish the recap.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-3">
      <h2 className="font-bold text-white text-sm">+ Add recap (Session {nextNumber})</h2>
      {error && <ErrorNote message={error} onRetry={publish} />}
      <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={'Title, e.g. "The Dragon’s Shadow"'} />
      <TextInput type="date" value={playedAt} onChange={(e) => setPlayedAt(e.target.value)} />
      <div className="flex items-center gap-2">
        <label className="text-xs font-bold text-slate-500 uppercase tracking-wide">Recap</label>
        <div className="flex-1" />
        <TemplateButton value={recap} onInsert={setRecap} />
      </div>
      <TextArea
        className="!min-h-[100px]"
        value={recap}
        onChange={(e) => setRecap(e.target.value)}
        placeholder="What happened? Plain text is fine — # headings and - bullets render nicely."
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-500">
          Tip: start from the template, or ask your AI scribe to <em>"draft a recap from this session"</em>.
        </p>
        <div className="flex gap-2 shrink-0">
          {onCancel && (
            <Btn ghost className="!min-h-0 !py-2 text-sm" onClick={onCancel}>
              Cancel
            </Btn>
          )}
          <Btn className="!min-h-0 !py-2 text-sm" onClick={publish} disabled={saving}>
            {saving ? 'Publishing…' : 'Publish recap'}
          </Btn>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * "Insert template" affordance — scaffolds the blank recap box with the shared
 * RECAP_TEMPLATE headings (Recap / Loot / NPCs met / Cliffhanger). Purely
 * client-side (no LLM): it gives the human a structure to fill. For an
 * AI-assisted draft seeded from this session's encounters + resolved inbox, the
 * connected agent uses the `draft_session_recap` MCP tool. When the box already
 * has content, the template is prepended rather than clobbering it.
 */
function TemplateButton({ value, onInsert }: { value: string; onInsert: (next: string) => void }) {
  const alreadyScaffolded = value.includes('## Recap');
  function insert() {
    if (value.trim() === '') onInsert(RECAP_TEMPLATE);
    else onInsert(`${RECAP_TEMPLATE}\n${value}`);
  }
  return (
    <Btn
      ghost
      type="button"
      className="!min-h-0 !py-1 text-xs"
      onClick={insert}
      disabled={alreadyScaffolded}
      title="Insert the Recap / Loot / NPCs met / Cliffhanger headings"
    >
      {alreadyScaffolded ? 'Template inserted' : 'Insert template'}
    </Btn>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return 'Undated';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Undated';
  return formatLocaleDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
