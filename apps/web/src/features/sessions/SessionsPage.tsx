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
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Session, SessionListItem, SessionShare, SessionShareCreated, SessionAttendee, Character } from '@campfire/schema';
import { RECAP_TEMPLATE } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { formatDate as formatLocaleDate, formatDateTime, useFormattingLocale } from '../../lib/format';
import { useAuth } from '../../app/auth';
import { Card, Btn, TextInput, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { useAnnounce } from '../../components/Announcer';
import { CopyControl } from '../../components/CopyControl';
import { SchedulePanel } from './SchedulePanel';
import { ScribePanel } from './ScribePanel';
import { CommentsThread } from '../comments/CommentsThread';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { DraftWithAiButton } from '../ai-dm/DraftWithAiButton';
import { entityTargetProps } from '../../lib/entityLinks';
import { useCampaign } from '../../app/CampaignContext';
import { localDateInputValue, millisecondsUntilNextLocalDate } from '../../lib/dateOnly';
import {
  assertMutationTarget,
  decideRouteBoundCommit,
  mutationsEnabledForRoute,
  RouteBoundLoadSequencer,
} from '../../lib/routeBoundRecord';
import {
  RECAP_BODY_HELP,
  RECAP_FIELD_LABELS,
  RECAP_PLAYED_ON_HELP,
  RECAP_TITLE_HELP,
  editRecapFieldIds,
  firstInvalidRecapControlId,
  newRecapFieldIds,
  recapDescribedBy,
  validateRecapFields,
  type RecapFieldErrors,
} from './recapFormFields';

/** Visible label text with the shared “· optional” marker (issue #859). */
function OptionalFieldLabel({ children }: { children: string }) {
  return (
    <>
      {children}{' '}
      <span className="text-slate-400 normal-case tracking-normal font-semibold">· optional</span>
    </>
  );
}

export default function SessionsPage() {
  useFormattingLocale();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { roleIn } = useAuth();
  const role = roleIn(cid);
  const isDm = role === 'dm';
  const announce = useAnnounce();

  const selectedId = searchParams.get('session');
  const recapAction = searchParams.get('action');
  const tab: 'log' | 'schedule' = searchParams.get('tab') === 'schedule' ? 'schedule' : 'log';

  // Roving-tabindex tablist — the selected tab holds tabindex 0, the rest -1, so
  // a single Tab keystroke lands in the panel and arrow keys move between tabs
  // (WAI-ARIA Tabs pattern). The refs back the focus() calls in onTabKeyDown.
  const tabRefs = useRef<Record<'log' | 'schedule', HTMLButtonElement | null>>({
    log: null,
    schedule: null,
  });
  const TAB_ORDER: ReadonlyArray<'log' | 'schedule'> = ['log', 'schedule'];

  function setTab(next: 'log' | 'schedule') {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next === 'schedule') params.set('tab', 'schedule');
      else params.delete('tab');
      return params;
    });
    announce(next === 'schedule' ? 'Schedule tab selected.' : 'Log tab selected.');
  }

  function focusTab(which: 'log' | 'schedule') {
    tabRefs.current[which]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const idx = TAB_ORDER.indexOf(tab);
    if (idx < 0) return;
    let next: 'log' | 'schedule' | null = null;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = TAB_ORDER[(idx + 1) % TAB_ORDER.length];
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length];
        break;
      case 'Home':
        next = TAB_ORDER[0];
        break;
      case 'End':
        next = TAB_ORDER[TAB_ORDER.length - 1];
        break;
      default:
        return;
    }
    if (next && next !== tab) {
      event.preventDefault();
      setTab(next);
      // setTab re-renders with the new selection; focus moves once the ref is live.
      requestAnimationFrame(() => focusTab(next));
    } else if (next) {
      event.preventDefault();
      focusTab(next);
    }
  }

  // Mobile list→detail focus management: when a recap is selected from the list
  // (only on narrow viewports, where list and detail are mutually exclusive),
  // move focus into the detail heading so a screen-reader user lands on the new
  // content rather than being stranded above it. Desktop keeps both panes
  // side-by-side, so focus is left where the user clicked.
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  // List-shape sessions (issue #71): each carries a `recapExcerpt`, not the full
  // recap body — SessionDetail fetches the full recap for the opened session.
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // The list/detail auto-open below is a desktop-only nicety: on desktop the list
  // and detail render side by side (two-pane), so auto-selecting the latest recap
  // just fills the empty detail pane. On mobile the two are mutually exclusive
  // (list OR detail), so auto-selecting would trap the user on the latest recap and
  // defeat "← Back to sessions" (it clears ?session, the effect re-adds it) — making
  // the full session list/history unreachable. Gate the auto-open on the `lg`
  // breakpoint (1024px) that the two-pane layout itself uses.
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const [showAddForm, setShowAddForm] = useState(false);
  useEffect(() => {
    // Reconcile browser Back/Forward for a deep-linked form. Local button opens
    // do not change recapAction, so they remain controlled by showAddForm.
    if (isDm && recapAction === 'new-recap') setShowAddForm(true);
    else if (recapAction !== 'new-recap') setShowAddForm(false);
  }, [isDm, recapAction]);

  function clearRecapAction() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get('action') === 'new-recap' || next.get('action') === 'edit-recap') next.delete('action');
        return next;
      },
      { replace: true },
    );
  }
  // Soft-delete Undo (issue #116/#269) lifted to the page level: on delete we refresh
  // the list immediately (so the trashed session stops showing without a manual reload)
  // and close the detail — the Undo bar must therefore outlive the now-unmounted detail.
  const [undoTarget, setUndoTarget] = useState<{ id: number; number: number } | null>(null);

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

  // Mobile focus management: on a narrow viewport, selecting a recap from the
  // timeline swaps list for detail. Move focus to the detail heading so SR/keyboard
  // users hear what they opened. Desktop keeps both panes visible, so focus is
  // left on the row the user activated. Skipped on the very first render (deep
  // link) so we don't yank focus away from the URL bar / screen-reader cursor.
  const prevSelectedIdRef = useRef<string | null>(selectedId);
  const bootedRef = useRef(false);
  useEffect(() => {
    const isFirstBoot = !bootedRef.current;
    bootedRef.current = true;
    const changed = prevSelectedIdRef.current !== selectedId;
    prevSelectedIdRef.current = selectedId;
    if (isFirstBoot || !changed || !selected) return;
    if (isDesktop) return;
    // The detail heading is the semantic "you are here" entry point for the pane.
    const id = window.requestAnimationFrame(() => {
      detailHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [selected, selectedId, isDesktop]);

  // Auto-open the latest recap when sessions exist but none is selected (or the
  // URL points at a session that's gone) — otherwise the detail pane sat on a
  // misleading "No sessions yet" empty state even with sessions in the list.
  useEffect(() => {
    if (isDesktop && tab === 'log' && recapAction !== 'new-recap' && sessions.length > 0 && !selected) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('session', String(sessions[0].id));
          return next;
        },
        { replace: true },
      );
    }
  }, [isDesktop, tab, recapAction, sessions, selected, setSearchParams]);

  function selectSession(id: number) {
    const picked = sessions.find((s) => s.id === id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('session', String(id));
      return next;
    });
    if (picked) {
      announce(
        `Session ${picked.number}${picked.title ? `, ${picked.title},` : ''} selected.`,
      );
    }
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

  // The detail deleted a session: drop it from the list right away (no lingering
  // "deleted" row), close the detail, and surface the Undo bar from here so it
  // survives the detail unmounting.
  async function handleDeleted(id: number, number: number) {
    setUndoTarget({ id, number });
    backToList();
    await load();
  }

  async function handleUndo() {
    if (!undoTarget) return;
    await api.post(`${API}/sessions/${undoTarget.id}/restore`);
    setUndoTarget(null);
    await load();
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
          <EmptyState icon="padlock" title="You don't have access to this campaign" />
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

  // The add form lives in the detail pane. Treat it like selected detail on
  // mobile; otherwise tapping "+ Add recap" mounts the form inside a pane that
  // remains `display: none` below the desktop breakpoint.
  const showDetailOnMobile = Boolean(selected) || (isDm && (showAddForm || sessions.length === 0));

  return (
    <div className="reading-surface max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      {error && <ErrorNote message={error} onRetry={load} />}

      <div className="flex items-center gap-2.5">
        <h1 className="text-2xl font-extrabold text-white">Sessions</h1>
        <div className="flex-1" />
        {isDm && (
          <Link to={`/c/${cid}/trash`} className="text-xs text-slate-500 hover:text-slate-300" title="Restore deleted entities">
            Trash
          </Link>
        )}
        {isDm && tab === 'log' && <DraftWithAiButton campaignId={cid} target="recap" label="Draft a recap with AI" />}
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

      {/*
        Log/Schedule tablist (issue #706) — was a colour-only segmented control with
        no tab semantics. It is now a WAI-ARIA Tabs pattern: role=tablist with two
        role=tab children (aria-selected, aria-controls, roving tabindex) and a
        matching role=tabpanel per tab. Arrow/Home/End move between tabs and the
        selected tab is the only one in the tab order; the deep-link query param
        (?tab=schedule) is still the source of truth so URLs keep working.
      */}
      <div className="seg self-start inline-flex" role="tablist" aria-label="Sessions view">
        {TAB_ORDER.map((t) => {
          const selectedTab = tab === t;
          const label = t === 'log' ? 'Log' : 'Schedule';
          return (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`sessions-tab-${t}`}
              aria-selected={selectedTab}
              aria-controls={`sessions-panel-${t}`}
              tabIndex={selectedTab ? 0 : -1}
              onClick={() => setTab(t)}
              onKeyDown={onTabKeyDown}
              style={{
                padding: '8px 16px',
                fontSize: 13,
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                color: selectedTab ? 'var(--color-accent)' : 'var(--color-neutral-500)',
                boxShadow: selectedTab ? 'inset 0 0 0 1px var(--color-accent)' : 'none',
                minHeight: 40,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/*
        Both panels are always mounted so aria-controls ↔ aria-labelledby resolve
        (a tab must point at a real panel). The inactive panel is visually hidden
        rather than unmounted, which also preserves SchedulePanel list/RSVP state
        when the user flips to Log and back.
      */}
      <div
        id="sessions-panel-schedule"
        role="tabpanel"
        aria-labelledby="sessions-tab-schedule"
        tabIndex={0}
        className={tab === 'schedule' ? '' : 'hidden'}
        hidden={tab !== 'schedule'}
      >
        <SchedulePanel campaignId={cid} isDm={isDm} />
      </div>
      <div
        id="sessions-panel-log"
        role="tabpanel"
        aria-labelledby="sessions-tab-log"
        tabIndex={0}
        className={tab === 'log' ? '' : 'hidden'}
        hidden={tab !== 'log'}
      >
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Timeline list */}
        <aside className={`min-w-0 space-y-3 ${showDetailOnMobile ? 'hidden lg:block' : ''}`}>
          {/* AI scribe (issue #342) — configure triggers, run on demand (with a dry-run
              preview), and review recent runs. Renders nothing until the AI DM seat is on. */}
          <ScribePanel campaignId={cid} isDm={isDm} />

          {sessions.length === 0 && !showAddForm ? (
            <Card>
              <EmptyState title="No sessions yet — add your first recap" />
            </Card>
          ) : (
            <ul className="flex flex-col" role="list" aria-label="Session recaps">
              {sessions.map((s) => {
                const isActive = selected?.id === s.id;
                const title = s.title || 'Untitled session';
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => selectSession(s.id)}
                      aria-current={isActive ? 'true' : undefined}
                      aria-label={`Session ${s.number}${s.title ? `, ${s.title},` : ''}, played ${formatDate(s.playedAt)}${isActive ? '. Selected.' : ''}`}
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
                        borderLeft: `2px solid ${isActive ? 'var(--color-accent)' : 'var(--color-accent-800)'}`,
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
                          background: isActive ? 'var(--color-accent)' : 'var(--color-accent-800)',
                        }}
                      />
                      <span className="flex-1 min-w-0">
                        <span className="flex gap-2.5 items-baseline flex-wrap">
                          <span className="text-xs whitespace-nowrap" style={{ color: 'var(--color-accent)' }}>
                            Session {s.number}
                          </span>
                          <span className="font-heading text-[16px]">{title}</span>
                          <span className="text-muted text-[11.5px] ml-auto">{formatDate(s.playedAt)}</span>
                        </span>
                        <span className="text-muted text-[13px] block mt-1 line-clamp-2">{s.recapExcerpt || 'No recap written yet.'}</span>
                      </span>
                      {/* sr-only "Selected" flag mirrors aria-current so screen readers
                          that don't voice aria-current on a <button> still get the state. */}
                      {isActive && <span className="sr-only">Selected</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        {/* Recap detail */}
        <main className={`min-w-0 lg:col-span-2 space-y-4 ${showDetailOnMobile ? '' : 'hidden lg:block'}`}>
          {selected ? (
            <SessionDetail
              key={selected.id}
              session={selected}
              campaignId={cid}
              isDm={isDm}
              startEditing={recapAction === 'edit-recap'}
              onEditActionHandled={clearRecapAction}
              onBack={backToList}
              onChange={load}
              onDeleted={handleDeleted}
              detailHeadingRef={detailHeadingRef}
            />
          ) : (
            <Card>
              {sessions.length > 0 ? (
                <EmptyState icon="open-book" title="Select a session" hint="Pick a recap from the timeline on the left." />
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
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('session', String(created.id));
                    next.delete('action');
                    return next;
                  },
                  { replace: recapAction === 'new-recap' },
                );
                void load();
              }}
              onCancel={
                sessions.length > 0
                  ? () => {
                      setShowAddForm(false);
                      clearRecapAction();
                    }
                  : undefined
              }
            />
          )}
        </main>
      </div>
      </div>

      {undoTarget && (
        <UndoSnackbar
          message={`Session ${undoTarget.number} moved to Trash.`}
          onUndo={handleUndo}
          onExpire={() => setUndoTarget(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SessionDetail({
  session,
  campaignId,
  isDm,
  startEditing,
  onEditActionHandled,
  onBack,
  onChange,
  onDeleted,
  detailHeadingRef,
}: {
  session: SessionListItem;
  campaignId: number;
  isDm: boolean;
  /** Open the existing recap editor when arriving from a post-encounter deep link. */
  startEditing: boolean;
  /** Removes the one-shot URL action after save/cancel so refresh does not reopen it. */
  onEditActionHandled: () => void;
  onBack: () => void;
  onChange: () => void;
  /** Session was soft-deleted — the page refreshes the list + owns the Undo bar. */
  onDeleted: (id: number, number: number) => void | Promise<void>;
  /** Mobile list→detail focus target (issue #706): heading receives focus when a
   *  recap is opened from the list so SR users land on the new content. */
  detailHeadingRef: RefObject<HTMLHeadingElement>;
}) {
  const [editing, setEditing] = useState(isDm && startEditing);
  const [titleDraft, setTitleDraft] = useState(session.title);
  const [dateDraft, setDateDraft] = useState(toDateInputValue(session.playedAt));
  // The list omits the full recap body (issue #71) — fetch it for the opened session.
  const [recap, setRecap] = useState('');
  const [recapLoading, setRecapLoading] = useState(true);
  const [recapDraft, setRecapDraft] = useState('');
  const [loadedSessionId, setLoadedSessionId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<RecapFieldErrors>({});
  // The `updatedAt` we last loaded — sent back on save as the optimistic-concurrency
  // guard (#157) so a co-DM's or a connected AI's interleaved edit 409s instead of being
  // silently clobbered. Bumped to null on a stale-conflict so the user must reload first.
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // Bumped after a save/restore to tell the history panel to refetch.
  const [historyNonce, setHistoryNonce] = useState(0);
  const loadSequencerRef = useRef(new RouteBoundLoadSequencer());
  const fieldIds = editRecapFieldIds(session.id);

  useEffect(() => {
    setEditing(isDm && startEditing);
    setTitleDraft(session.title);
    setDateDraft(toDateInputValue(session.playedAt));
    // Issue #853: clear prior recap/draft immediately so a slow A fetch cannot leave
    // A's prose editable against B (key= remounts help; sequencer covers races).
    setRecap('');
    setRecapDraft('');
    setLoadedSessionId(null);
    setLoadedUpdatedAt(null);
    setConflict(false);
    setConfirmingDelete(false);
    setError(null);
    setFieldErrors({});
    setRecapLoading(true);
    const { generation, signal } = loadSequencerRef.current.begin(session.id);
    api
      .get<Session>(`${API}/sessions/${session.id}`, { signal })
      .then((full) => {
        const decision = decideRouteBoundCommit(loadSequencerRef.current, generation, session.id, full);
        if (decision.kind !== 'commit') return;
        setRecap(decision.record.recap);
        setRecapDraft(decision.record.recap);
        setLoadedUpdatedAt(decision.record.updatedAt);
        setLoadedSessionId(decision.record.id);
        setConflict(false);
      })
      .catch((err) => {
        if (!loadSequencerRef.current.isCurrent(generation, session.id)) return;
        setRecap('');
        setRecapDraft('');
        setLoadedUpdatedAt(null);
        setLoadedSessionId(null);
        if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : "Couldn't load this recap.");
      })
      .finally(() => {
        if (loadSequencerRef.current.isCurrent(generation, session.id)) setRecapLoading(false);
      });
    const sequencer = loadSequencerRef.current;
    return () => sequencer.invalidate();
  }, [session, isDm, startEditing]);

  const detailReady = mutationsEnabledForRoute(
    loadedSessionId != null ? { id: loadedSessionId } : null,
    session.id,
    recapLoading,
  );

  async function save() {
    if (!assertMutationTarget(loadedSessionId, session.id).ok) return;
    const nextErrors = validateRecapFields({
      title: titleDraft,
      playedAt: dateDraft,
      recap: recapDraft,
    });
    setFieldErrors(nextErrors);
    // Keep an active 409 conflict banner until validation passes and we actually
    // attempt a save — a failed client check must not dismiss Reload latest.
    const invalidId = firstInvalidRecapControlId(nextErrors, fieldIds);
    if (invalidId) {
      document.getElementById(invalidId)?.focus();
      return;
    }

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
      setLoadedSessionId(updated.id);
      setEditing(false);
      onEditActionHandled();
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
      document.getElementById(fieldIds.title.controlId)?.focus();
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    setError(null);
    setConflict(false);
    setFieldErrors({});
    setRecapLoading(true);
    try {
      const full = await api.get<Session>(`${API}/sessions/${session.id}`);
      setRecap(full.recap);
      setRecapDraft(full.recap);
      setLoadedUpdatedAt(full.updatedAt);
      setLoadedSessionId(full.id);
    } catch {
      setError("Couldn't reload the latest recap.");
    } finally {
      setRecapLoading(false);
    }
  }

  async function remove() {
    if (!assertMutationTarget(loadedSessionId, session.id).ok) return;
    setDeleting(true);
    setError(null);
    try {
      // Soft-delete (issue #116) — reversible. Hand off to the page: it refreshes the
      // list immediately (the trashed session stops showing without a manual reload,
      // issue #269) and owns the Undo bar, which must outlive this now-unmounting detail.
      await api.delete(`${API}/sessions/${session.id}`);
      setConfirmingDelete(false);
      await onDeleted(session.id, session.number);
    } catch {
      setError("Couldn't delete the session.");
      setDeleting(false);
    }
  }

  return (
    <div className="reading-surface space-y-3" style={{ maxWidth: 720 }} {...entityTargetProps('session', session.id)}>
      <div>
        <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300 lg:hidden mb-1 block">
          ← Back to sessions
        </button>
      </div>
      {!editing && error && <ErrorNote message={error} />}
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <span className="tag tag-accent">Session {session.number}</span>
        <h2
          ref={detailHeadingRef}
          tabIndex={-1}
          className="text-xl font-extrabold text-white m-0 focus:outline-none"
        >
          {session.title || 'Untitled session'}
        </h2>
        <span className="text-muted text-xs">{formatDate(session.playedAt)}</span>
      </div>

      {editing ? (
        <Card className="edit-recap-form min-w-0 space-y-3">
          <form
            className="min-w-0 space-y-3"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {error && (
              <div id={fieldIds.formErrorId}>
                <ErrorNote message={error} />
              </div>
            )}
            <div className="min-w-0 space-y-1">
              <label
                htmlFor={fieldIds.title.controlId}
                className="block text-xs font-bold text-slate-300 uppercase tracking-wide break-words"
              >
                <OptionalFieldLabel>{RECAP_FIELD_LABELS.title}</OptionalFieldLabel>
              </label>
              <TextInput
                id={fieldIds.title.controlId}
                name="title"
                className="min-w-0"
                value={titleDraft}
                onChange={(e) => {
                  setTitleDraft(e.target.value);
                  setFieldErrors((current) => ({ ...current, title: undefined }));
                }}
                placeholder="Session title…"
                aria-invalid={fieldErrors.title ? true : undefined}
                aria-describedby={recapDescribedBy(fieldIds.title, {
                  error: Boolean(fieldErrors.title),
                  formErrorId: error && !fieldErrors.title ? fieldIds.formErrorId : null,
                })}
              />
              <p id={fieldIds.title.helpId} className="m-0 text-xs text-slate-400 break-words">
                {RECAP_TITLE_HELP}
              </p>
              {fieldErrors.title && (
                <p id={fieldIds.title.errorId} role="alert" className="m-0 text-xs text-rose-400">
                  {fieldErrors.title}
                </p>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <label
                htmlFor={fieldIds.playedAt.controlId}
                className="block text-xs font-bold text-slate-300 uppercase tracking-wide break-words"
              >
                <OptionalFieldLabel>{RECAP_FIELD_LABELS.playedAt}</OptionalFieldLabel>
              </label>
              <TextInput
                id={fieldIds.playedAt.controlId}
                name="playedAt"
                className="min-w-0"
                type="date"
                value={dateDraft}
                onChange={(e) => {
                  setDateDraft(e.target.value);
                  setFieldErrors((current) => ({ ...current, playedAt: undefined }));
                }}
                aria-invalid={fieldErrors.playedAt ? true : undefined}
                aria-describedby={recapDescribedBy(fieldIds.playedAt, {
                  error: Boolean(fieldErrors.playedAt),
                })}
              />
              <p id={fieldIds.playedAt.helpId} className="m-0 text-xs text-slate-400 break-words">
                {RECAP_PLAYED_ON_HELP}
              </p>
              {fieldErrors.playedAt && (
                <p id={fieldIds.playedAt.errorId} role="alert" className="m-0 text-xs text-rose-400">
                  {fieldErrors.playedAt}
                </p>
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <label
                  htmlFor={fieldIds.recap.controlId}
                  className="text-xs font-bold text-slate-300 uppercase tracking-wide break-words"
                >
                  <OptionalFieldLabel>{RECAP_FIELD_LABELS.recap}</OptionalFieldLabel>
                </label>
                <div className="flex-1 min-w-0" />
                <TemplateButton value={recapDraft} onInsert={setRecapDraft} />
              </div>
              <TextArea
                id={fieldIds.recap.controlId}
                name="recap"
                className="min-w-0"
                autoFocus={startEditing}
                style={{ minHeight: 200 }}
                value={recapDraft}
                onChange={(e) => {
                  setRecapDraft(e.target.value);
                  setFieldErrors((current) => ({ ...current, recap: undefined }));
                }}
                placeholder="What happened? Plain text is fine — # headings and - bullets render nicely."
                aria-invalid={fieldErrors.recap ? true : undefined}
                aria-describedby={recapDescribedBy(fieldIds.recap, {
                  error: Boolean(fieldErrors.recap),
                })}
              />
              <p id={fieldIds.recap.helpId} className="m-0 text-xs text-slate-400 break-words">
                {RECAP_BODY_HELP}
              </p>
              {fieldErrors.recap && (
                <p id={fieldIds.recap.errorId} role="alert" className="m-0 text-xs text-rose-400">
                  {fieldErrors.recap}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2 justify-end items-center">
              {conflict && (
                <Btn ghost type="button" className="!min-h-0 !py-1.5 text-xs" onClick={reloadLatest} disabled={saving}>
                  Reload latest
                </Btn>
              )}
              <Btn
                ghost
                type="button"
                className="!min-h-0 !py-1.5 text-xs"
                onClick={() => {
                  setEditing(false);
                  setFieldErrors({});
                  setError(null);
                  setConflict(false);
                  onEditActionHandled();
                }}
              >
                Cancel
              </Btn>
              <Btn type="submit" className="!min-h-0 !py-1.5 text-xs" disabled={saving || !detailReady}>
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </form>
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
          <Btn danger ghost className="!min-h-0 !py-1.5 text-xs" onClick={() => setConfirmingDelete(true)} busy={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Btn>
        </div>
      )}

      {!editing && <SharePanel sessionId={session.id} campaignId={campaignId} isDm={isDm} />}

      {/* Recap revision history + restore (issue #157) — DM-only, so a clobbered or
          regretted edit can be recovered. Refetches whenever a save/restore happens. */}
      {isDm && !editing && (
        <RevisionHistoryPanel
          entityType="session"
          entityId={session.id}
          currentSnapshot={{ recap }}
          expectedUpdatedAt={loadedUpdatedAt}
          label="Recap history"
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
          body={
            <>
              This moves the session (recap, attendance, share links) to the Trash — you can undo it, or restore it later
              from the{' '}
              <Link to={`/c/${campaignId}/trash`} className="underline" style={{ color: 'var(--color-accent)' }}>
                campaign Trash
              </Link>
              .
            </>
          }
          confirmLabel="Delete session"
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmingDelete(false)}
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
  const [loadedForSessionId, setLoadedForSessionId] = useState<number | null>(null);
  const loadSequencerRef = useRef(new RouteBoundLoadSequencer());

  const load = useCallback(async () => {
    const { generation, signal } = loadSequencerRef.current.begin(sessionId);
    setLoading(true);
    // Issue #853: drop the prior session's roster immediately so a save cannot
    // PUT A's attendance into B while B's fetch is still in flight.
    setAttendees([]);
    setSelected(new Set());
    setLoadedForSessionId(null);
    setEditing(false);
    setError(null);
    try {
      const next = await api.get<SessionAttendee[]>(`${API}/sessions/${sessionId}/attendance`, { signal });
      if (!loadSequencerRef.current.isCurrent(generation, sessionId)) return;
      setAttendees(next);
      setLoadedForSessionId(sessionId);
    } catch (err) {
      if (!loadSequencerRef.current.isCurrent(generation, sessionId)) return;
      setAttendees([]);
      setLoadedForSessionId(null);
      if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
      // Attendance is a non-critical embellishment — surface retry via the empty state.
      setError("Couldn't load attendance.");
    } finally {
      if (loadSequencerRef.current.isCurrent(generation, sessionId)) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const sequencer = loadSequencerRef.current;
    return () => sequencer.invalidate();
  }, [load]);

  const attendanceReady = mutationsEnabledForRoute(
    loadedForSessionId != null ? { id: loadedForSessionId } : null,
    sessionId,
    loading,
  );

  async function startEditing() {
    if (!attendanceReady) return;
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
    if (!assertMutationTarget(loadedForSessionId, sessionId).ok) return;
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

  if (loading || !attendanceReady) return null;

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
            <Btn className="!min-h-0 !py-1.5 text-xs" onClick={save} disabled={saving || !attendanceReady}>
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

type ShareLifetime = '1' | '7' | '30' | 'never';

/** Member-visible status plus DM-only capability controls for one recap. */
function SharePanel({ sessionId, campaignId, isDm }: { sessionId: number; campaignId: number; isDm: boolean }) {
  const campaign = useCampaign(campaignId);
  const [shares, setShares] = useState<SessionShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [lifetime, setLifetime] = useState<ShareLifetime>('7');
  const [acknowledgedNever, setAcknowledgedNever] = useState(false);
  const [newLink, setNewLink] = useState<{ shareId: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const policyEnabled = campaign?.publicRecapSharingEnabled !== false;
  const newLinkId = `recap-share-url-${sessionId}`;

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
    void load();
  }, [load]);

  async function create() {
    if (lifetime === 'never' && !acknowledgedNever) return;
    setCreating(true);
    setError(null);
    try {
      const expiresAt = lifetime === 'never'
        ? null
        : new Date(Date.now() + Number(lifetime) * 24 * 60 * 60 * 1000).toISOString();
      const res = await api.post<SessionShareCreated>(`${API}/sessions/${sessionId}/shares`, { label, expiresAt });
      setNewLink({ shareId: res.share.id, url: `${window.location.origin}/share/${res.token}` });
      setLabel('');
      setLifetime('7');
      setAcknowledgedNever(false);
      await load();
    } catch {
      setError("Couldn't create a share link.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Card className="space-y-3" data-testid="recap-share-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="font-bold text-white text-sm m-0">Public recap sharing</h3>
        {!loading && shares.length > 0 && <span className="tag tag-accent">{shares.length} active</span>}
      </div>
      <p className="text-[11.5px] text-slate-300 m-0">
        Anyone who receives an active link can forward it and read the current recap without an account. All campaign
        members can see who enabled sharing, when it expires, and how often it has been opened.
      </p>
      {!policyEnabled && (
        <p className="text-xs text-amber-300 m-0" role="status">
          Public recap sharing is disabled in Campaign settings. Existing links were revoked.
        </p>
      )}
      {error && <ErrorNote message={error} onRetry={load} />}

      {isDm && policyEnabled && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_150px_auto] items-end">
          <div className="field !mb-0">
            <label htmlFor={`share-label-${sessionId}`}>Label</label>
            <TextInput
              id={`share-label-${sessionId}`}
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Absent players"
            />
          </div>
          <div className="field !mb-0">
            <label htmlFor={`share-expiry-${sessionId}`}>Expires</label>
            <select
              id={`share-expiry-${sessionId}`}
              className="input"
              value={lifetime}
              onChange={(event) => {
                setLifetime(event.target.value as ShareLifetime);
                setAcknowledgedNever(false);
              }}
            >
              <option value="1">In 24 hours</option>
              <option value="7">In 7 days</option>
              <option value="30">In 30 days</option>
              <option value="never">Never</option>
            </select>
          </div>
          <Btn
            className="!min-h-0 !py-2 text-xs !bg-violet-700 !border-violet-700 !text-white"
            onClick={create}
            busy={creating}
            disabled={lifetime === 'never' && !acknowledgedNever}
          >
            {creating ? 'Creating…' : 'Create link'}
          </Btn>
          {lifetime === 'never' && (
            <label className="sm:col-span-3 flex items-start gap-2 text-xs text-amber-200">
              <input
                type="checkbox"
                checked={acknowledgedNever}
                onChange={(event) => setAcknowledgedNever(event.target.checked)}
              />
              <span>I understand this link remains public until a DM revokes it.</span>
            </label>
          )}
        </div>
      )}

      {newLink && (
        <div className="flex items-center gap-2 flex-wrap">
          <code
            id={newLinkId}
            className="text-xs break-all flex-1 min-w-0"
            style={{ color: 'var(--color-accent)' }}
          >
            {newLink.url}
          </code>
          <CopyControl
            text={newLink.url}
            selectTargetId={newLinkId}
            label="Copy link"
            copiedLabel="Copied ✓"
            ghost
            className="!min-h-0 !py-1.5 text-xs shrink-0"
            successAnnouncement="Share link copied to clipboard."
            failureAnnouncement="Copy failed. Clipboard blocked — select the link and copy it manually."
          />
        </div>
      )}

      {loading ? (
        <Skeleton lines={2} />
      ) : shares.length === 0 ? (
        <p className="text-sm text-slate-600 m-0">No active links.</p>
      ) : (
        <ul className="m-0 p-0 space-y-2" style={{ listStyle: 'none' }}>
          {shares.map((s) => (
            <ShareRow
              key={s.id}
              share={s}
              sessionId={sessionId}
              isDm={isDm}
              onChanged={load}
              onRevoked={(shareId) => setNewLink((current) => current?.shareId === shareId ? null : current)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function ShareRow({
  share,
  sessionId,
  isDm,
  onChanged,
  onRevoked,
}: {
  share: SessionShare;
  sessionId: number;
  isDm: boolean;
  onChanged: () => Promise<void>;
  onRevoked: (shareId: number) => void;
}) {
  const [draftLabel, setDraftLabel] = useState(share.label);
  const [busy, setBusy] = useState<'label' | 'extend' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(kind: 'label' | 'extend' | 'revoke') {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'revoke') {
        await api.delete(`${API}/sessions/${sessionId}/shares/${share.id}`);
        onRevoked(share.id);
      } else {
        const currentExpiry = share.expiresAt ? Date.parse(share.expiresAt) : Date.now();
        const body = kind === 'label'
          ? { label: draftLabel }
          : { expiresAt: new Date(Math.max(Date.now(), currentExpiry) + 7 * 24 * 60 * 60 * 1000).toISOString() };
        await api.patch(`${API}/sessions/${sessionId}/shares/${share.id}`, body);
      }
      await onChanged();
    } catch {
      setError(`Couldn't ${kind === 'revoke' ? 'revoke' : kind === 'extend' ? 'extend' : 'rename'} this link.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="rounded-md border border-slate-700/70 p-2.5 text-xs space-y-2">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="m-0 text-slate-200 font-semibold break-words">{share.label || 'Unlabelled link'}</p>
          <p className="m-0 text-muted">
            Created by {share.createdBy || 'Unknown member'} · {share.expiresAt ? `expires ${formatDateTime(share.expiresAt)}` : 'never expires'}
          </p>
          <p className="m-0 text-muted">
            Opened {share.accessCount} {share.accessCount === 1 ? 'time' : 'times'}
            {share.lastAccessedAt ? ` · last ${formatDateTime(share.lastAccessedAt)}` : ' · not opened yet'}
          </p>
        </div>
        <code className="text-slate-300 shrink-0" aria-label="Share token display prefix">{share.tokenPrefix}…</code>
      </div>
      {isDm && (
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <label className="sr-only" htmlFor={`share-row-label-${share.id}`}>Edit share label</label>
          <TextInput
            id={`share-row-label-${share.id}`}
            className="!min-h-0 !py-1.5 text-xs flex-1"
            maxLength={120}
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
          />
          <Btn ghost className="!min-h-0 !py-1.5 text-xs" busy={busy === 'label'} disabled={busy !== null || draftLabel === share.label} onClick={() => void mutate('label')}>
            {busy === 'label' ? 'Saving…' : 'Save label'}
          </Btn>
          {share.expiresAt && (
            <Btn ghost className="!min-h-0 !py-1.5 text-xs" busy={busy === 'extend'} disabled={busy !== null} onClick={() => void mutate('extend')}>
              {busy === 'extend' ? 'Extending…' : 'Extend 7 days'}
            </Btn>
          )}
          <Btn danger ghost className="!min-h-0 !py-1.5 text-xs" busy={busy === 'revoke'} disabled={busy !== null} onClick={() => void mutate('revoke')}>
            {busy === 'revoke' ? 'Revoking…' : 'Revoke'}
          </Btn>
        </div>
      )}
      {error && <p className="m-0 text-red-400" role="alert">{error}</p>}
    </li>
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
  const [playedAt, setPlayedAt] = useState(() => localDateInputValue());
  const dateWasEdited = useRef(false);
  const [recap, setRecap] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<RecapFieldErrors>({});
  const fieldIds = newRecapFieldIds();

  // A form can stay open while a session runs across midnight. Keep the
  // suggested date aligned with the user's local calendar until they make an
  // explicit choice; after that, even an intentionally-cleared date belongs to
  // the user and must not be replaced. Focus/visibility refreshes cover laptops
  // that sleep through the scheduled midnight callback.
  useEffect(() => {
    let midnightTimer: number | undefined;

    function updateSuggestedDate() {
      if (!dateWasEdited.current) setPlayedAt(localDateInputValue());
    }

    function scheduleMidnightRefresh() {
      if (midnightTimer !== undefined) window.clearTimeout(midnightTimer);
      const now = new Date();
      midnightTimer = window.setTimeout(() => {
        updateSuggestedDate();
        scheduleMidnightRefresh();
      }, millisecondsUntilNextLocalDate(now) + 1);
    }

    function refreshAfterPause() {
      updateSuggestedDate();
      scheduleMidnightRefresh();
    }

    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') refreshAfterPause();
    }

    scheduleMidnightRefresh();
    window.addEventListener('focus', refreshAfterPause);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      if (midnightTimer !== undefined) window.clearTimeout(midnightTimer);
      window.removeEventListener('focus', refreshAfterPause);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  async function publish() {
    const nextErrors = validateRecapFields({ title, playedAt, recap });
    setFieldErrors(nextErrors);
    // Keep an existing API failure banner until validation passes and we actually
    // attempt a publish — a failed client check must not drop formErrorId from
    // the title's aria-describedby.
    const invalidId = firstInvalidRecapControlId(nextErrors, fieldIds);
    if (invalidId) {
      document.getElementById(invalidId)?.focus();
      return;
    }

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
      setFieldErrors({});
      onCreated(created);
    } catch {
      setError("Couldn't publish the recap.");
      document.getElementById(fieldIds.title.controlId)?.focus();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="new-recap-form min-w-0 space-y-3">
      <h2 className="font-bold text-white text-sm">+ Add recap (Session {nextNumber})</h2>
      {error && (
        <div id={fieldIds.formErrorId}>
          <ErrorNote message={error} onRetry={publish} />
        </div>
      )}
      <form
        className="min-w-0 space-y-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void publish();
        }}
      >
        <div className="min-w-0 space-y-1">
          <label
            htmlFor={fieldIds.title.controlId}
            className="block text-xs font-bold text-slate-300 uppercase tracking-wide break-words"
          >
            <OptionalFieldLabel>{RECAP_FIELD_LABELS.title}</OptionalFieldLabel>
          </label>
          <TextInput
            id={fieldIds.title.controlId}
            name="title"
            className="min-w-0"
            autoFocus
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setFieldErrors((current) => ({ ...current, title: undefined }));
            }}
            placeholder={'e.g. "The Dragon’s Shadow"'}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={recapDescribedBy(fieldIds.title, {
              error: Boolean(fieldErrors.title),
              formErrorId: error && !fieldErrors.title ? fieldIds.formErrorId : null,
            })}
          />
          <p id={fieldIds.title.helpId} className="m-0 text-xs text-slate-400 break-words">
            {RECAP_TITLE_HELP}
          </p>
          {fieldErrors.title && (
            <p id={fieldIds.title.errorId} role="alert" className="m-0 text-xs text-rose-400">
              {fieldErrors.title}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <label
            htmlFor={fieldIds.playedAt.controlId}
            className="block text-xs font-bold text-slate-300 uppercase tracking-wide break-words"
          >
            <OptionalFieldLabel>{RECAP_FIELD_LABELS.playedAt}</OptionalFieldLabel>
          </label>
          <TextInput
            id={fieldIds.playedAt.controlId}
            name="playedAt"
            className="min-w-0"
            type="date"
            value={playedAt}
            onChange={(e) => {
              dateWasEdited.current = true;
              setPlayedAt(e.target.value);
              setFieldErrors((current) => ({ ...current, playedAt: undefined }));
            }}
            aria-invalid={fieldErrors.playedAt ? true : undefined}
            aria-describedby={recapDescribedBy(fieldIds.playedAt, {
              error: Boolean(fieldErrors.playedAt),
            })}
          />
          <p id={fieldIds.playedAt.helpId} className="m-0 text-xs text-slate-400 break-words">
            {RECAP_PLAYED_ON_HELP}
          </p>
          {fieldErrors.playedAt && (
            <p id={fieldIds.playedAt.errorId} role="alert" className="m-0 text-xs text-rose-400">
              {fieldErrors.playedAt}
            </p>
          )}
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={fieldIds.recap.controlId}
              className="text-xs font-bold text-slate-300 uppercase tracking-wide break-words"
            >
              <OptionalFieldLabel>{RECAP_FIELD_LABELS.recap}</OptionalFieldLabel>
            </label>
            <div className="flex-1 min-w-0" />
            <TemplateButton value={recap} onInsert={setRecap} />
          </div>
          <TextArea
            id={fieldIds.recap.controlId}
            name="recap"
            className="!min-h-[100px] min-w-0"
            value={recap}
            onChange={(e) => {
              setRecap(e.target.value);
              setFieldErrors((current) => ({ ...current, recap: undefined }));
            }}
            placeholder="What happened? Plain text is fine — # headings and - bullets render nicely."
            aria-invalid={fieldErrors.recap ? true : undefined}
            aria-describedby={recapDescribedBy(fieldIds.recap, {
              error: Boolean(fieldErrors.recap),
            })}
          />
          <p id={fieldIds.recap.helpId} className="m-0 text-xs text-slate-400 break-words">
            {RECAP_BODY_HELP}
          </p>
          {fieldErrors.recap && (
            <p id={fieldIds.recap.errorId} role="alert" className="m-0 text-xs text-rose-400">
              {fieldErrors.recap}
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-[11px] text-slate-400 break-words">
            Tip: start from the template, or ask your AI scribe to <em>"draft a recap from this session"</em>.
          </p>
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            {onCancel && (
              <Btn ghost type="button" className="!min-h-0 !py-2 text-sm" onClick={onCancel}>
                Cancel
              </Btn>
            )}
            <Btn type="submit" className="!min-h-0 !py-2 text-sm" disabled={saving}>
              {saving ? 'Publishing…' : 'Publish recap'}
            </Btn>
          </div>
        </div>
      </form>
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
  if (Number.isNaN(new Date(iso).getTime())) return 'Undated';
  // Pass the raw string (not a pre-parsed Date) so date-only values like
  // `2026-07-21` get calendar treatment in formatLocaleDate (issue #267).
  return formatLocaleDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
