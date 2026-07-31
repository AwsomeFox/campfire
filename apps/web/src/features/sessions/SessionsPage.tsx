import { useTranslation } from 'react-i18next';
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
import type { Session, SessionListItem, SessionListPage, SessionShare, SessionShareCreated, SessionAttendee, Character, ScheduledSessionWithRsvps, SessionRsvp } from '@campfire/schema';
import { RECAP_TEMPLATE, SESSIONS_LIST_DEFAULT_LIMIT } from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { useProtectedForm } from '../../lib/useProtectedForm';
import { joinPublicBase } from '../../lib/public-base';
import { formatDate as formatLocaleDate, formatDateTime, useFormattingLocale } from '../../lib/format';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Card, Btn, TextInput, TextArea, EmptyState, Skeleton, SkeletonConditionalRegion, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { PrintControl } from '../../components/PrintControl';
import { PrintOnly } from '../../components/PrintOnly';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UndoSnackbar } from '../../components/UndoSnackbar';
import { useAnnounce } from '../../components/Announcer';
import { CopyControl } from '../../components/CopyControl';
import { SchedulePanel } from './SchedulePanel';
import { ScribePanel } from './ScribePanel';
import { EntityDiscussion } from '../comments/EntityDiscussion';
import { EncounterBacklinksCard } from '../../components/EncounterBacklinksCard';
import { RevisionHistoryPanel } from '../../components/RevisionHistoryPanel';
import { PageHeader, type PageHeaderSecondaryAction } from '../../components/PageHeader';
import { VirtualList } from '../../components/VirtualList';
import { usePageHeaderDraftWithAi } from '../ai-dm/usePageHeaderDraftWithAi';
import { entityTargetProps } from '../../lib/entityLinks';
import { useCampaign } from '../../app/CampaignContext';
import { localDateInputValue, millisecondsUntilNextLocalDate } from '../../lib/dateOnly';
import { consumeEncounterAftermathRecap } from '../encounters/encounterAftermathHandoff';
import {
  assertMutationTarget,
  decideRouteBoundCommit,
  mutationsEnabledForRoute,
  RouteBoundLoadSequencer,
} from '../../lib/routeBoundRecord';
import {
  RECAP_BODY_HELP,
  RECAP_DM_SECRET_HELP,
  RECAP_FIELD_LABELS,
  RECAP_PLAYED_ON_HELP,
  RECAP_TITLE_HELP,
  editRecapFieldIds,
  EMPTY_RECAP_EDITOR_DRAFT,
  firstInvalidRecapControlId,
  isRecapEditorDirty,
  newRecapFieldIds,
  recapDescribedBy,
  recapEditorDraftFromSession,
  recapEditorDraftsEqual,
  validateRecapFields,
  type RecapEditorDraft,
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
  const { t } = useTranslation();
  useFormattingLocale();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { isDm, canDmWrite } = useCampaignAccess();
  const announce = useAnnounce();

  const selectedId = searchParams.get('session');
  const recapAction = searchParams.get('action');
  const fromEncounterId = Number(searchParams.get('fromEncounter'));
  const rawFromSchedule = Number(searchParams.get('fromSchedule'));
  const fromScheduleId = Number.isFinite(rawFromSchedule) && rawFromSchedule > 0 ? rawFromSchedule : null;
  const aftermathRecapSeed =
    Number.isFinite(fromEncounterId) && fromEncounterId > 0
      ? consumeEncounterAftermathRecap(cid, fromEncounterId)
      : null;
  const tab: 'log' | 'schedule' = searchParams.get('tab') === 'schedule' ? 'schedule' : 'log';
  const { secondaryAction: draftAction, draftDialog } = usePageHeaderDraftWithAi({
    campaignId: cid,
    target: 'recap',
    label: 'Draft a recap with AI',
    enabled: canDmWrite && tab === 'log',
  });

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
  const [totalSessions, setTotalSessions] = useState(0);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [sessionOffset, setSessionOffset] = useState(0);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
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
    if (canDmWrite && (recapAction === 'new-recap' || fromScheduleId !== null)) setShowAddForm(true);
    else if (recapAction !== 'new-recap' && fromScheduleId === null) setShowAddForm(false);
  }, [canDmWrite, recapAction, fromScheduleId]);

  function clearRecapAction() {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get('action') === 'new-recap' || next.get('action') === 'edit-recap') next.delete('action');
        next.delete('fromSchedule');
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
    setSessionOffset(0);
    try {
      const page = await api.get<SessionListPage>(
        `${API}/campaigns/${cid}/sessions?limit=${SESSIONS_LIST_DEFAULT_LIMIT}&offset=0`,
      );
      setSessions(page.items);
      setTotalSessions(page.total);
      setHasMoreSessions(page.hasMore);
      setSessionOffset(page.items.length);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError(t('sessions.errors.loadSessions'));
      }
    } finally {
      setLoading(false);
    }
  }, [cid]);

  const loadMoreSessions = useCallback(async () => {
    if (!hasMoreSessions || loadingMoreSessions || loading) return;
    setLoadingMoreSessions(true);
    setError(null);
    try {
      const page = await api.get<SessionListPage>(
        `${API}/campaigns/${cid}/sessions?limit=${SESSIONS_LIST_DEFAULT_LIMIT}&offset=${sessionOffset}`,
      );
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...page.items.filter((s) => !seen.has(s.id))];
      });
      setTotalSessions(page.total);
      setHasMoreSessions(page.hasMore);
      setSessionOffset((prev) => prev + page.items.length);
    } catch {
      setError(t('sessions.errors.loadMoreSessions'));
    } finally {
      setLoadingMoreSessions(false);
    }
  }, [cid, hasMoreSessions, loadingMoreSessions, loading, sessionOffset, t]);

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
    if (sessions.length === 0) return 1;
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
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-5xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="padlock" title={t('sessions.accessDenied')} />
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
  const showDetailOnMobile = Boolean(selected) || (canDmWrite && (showAddForm || sessions.length === 0));

  const secondaryActions: PageHeaderSecondaryAction[] = [];
  if (isDm) {
    secondaryActions.push({ key: 'trash', label: 'Trash', href: `/c/${cid}/trash` });
  }
  if (draftAction) {
    secondaryActions.push(draftAction);
  }

  return (
    <div className="reading-surface max-w-5xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      {error && <ErrorNote message={error} onRetry={load} />}

      <PageHeader
        title={t('sessions.title')}
        secondaryActions={secondaryActions}
        primaryAction={
          canDmWrite && tab === 'log' ? (
            <Btn
              type="button"
              className="cf-page-header__action"
              onClick={() => {
                setShowAddForm(true);
                if (selected) backToList();
              }}
            >
              + Add recap
            </Btn>
          ) : undefined
        }
      />
      {draftDialog}

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
        <aside className={`cf-print-hide min-w-0 space-y-3 ${showDetailOnMobile ? 'hidden lg:block' : ''}`}>
          {/* AI scribe (issue #342) — configure triggers, run on demand (with a dry-run
              preview), and review recent runs. Renders nothing until the AI DM seat is on. */}
          <ScribePanel campaignId={cid} isDm={isDm} />

          {sessions.length === 0 && !showAddForm ? (
            <Card>
              <EmptyState title={t('sessions.empty.noSessions')} />
            </Card>
          ) : (
            <div className="space-y-2">
              <p className="text-muted text-xs m-0" role="status">
                {totalSessions > 0
                  ? `Showing ${sessions.length} of ${totalSessions} session${totalSessions === 1 ? '' : 's'}`
                  : ''}
              </p>
              <div role="list" aria-label="Session recaps">
              <VirtualList
                items={sessions}
                estimateHeight={96}
                maxHeight="min(70vh, 640px)"
                className="flex flex-col"
              >
                {(s) => {
                  const isActive = selected?.id === s.id;
                  const title = s.title || 'Untitled session';
                  return (
                    <div key={s.id} role="listitem">
                      <button
                        type="button"
                        onClick={() => selectSession(s.id)}
                        aria-current={isActive ? 'true' : undefined}
                        aria-label={`Session ${s.number}${s.title ? `, ${s.title},` : ''}, played ${formatDate(s.playedAt)}${isActive ? '. Selected.' : ''}`}
                        className="text-left w-full"
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
                        {isActive && <span className="sr-only">Selected</span>}
                      </button>
                    </div>
                  );
                }}
              </VirtualList>
              </div>
              {hasMoreSessions && (
                <Btn density="xs"
                  ghost
                  type="button"
                  className="text-xs w-full"
                  onClick={() => void loadMoreSessions()}
                  disabled={loadingMoreSessions}
                >
                  {loadingMoreSessions ? 'Loading…' : 'Load older sessions'}
                </Btn>
              )}
            </div>
          )}
        </aside>

        {/* Recap detail */}
        <main className={`min-w-0 lg:col-span-2 space-y-4 ${showDetailOnMobile ? '' : 'hidden lg:block'}`}>
          {selected ? (
            <SessionDetail
              key={selected.id}
              session={selected}
              campaignId={cid}
              startEditing={recapAction === 'edit-recap'}
              seedRecap={aftermathRecapSeed}
              onEditActionHandled={clearRecapAction}
              onBack={backToList}
              onChange={load}
              onDeleted={handleDeleted}
              detailHeadingRef={detailHeadingRef}
            />
          ) : (
            <Card>
              {sessions.length > 0 ? (
                <EmptyState icon="open-book" title={t('sessions.empty.selectSession')} hint={t('sessions.empty.selectSessionHint')} />
              ) : (
                <EmptyState title={t('sessions.empty.noSessions')} hint={t('sessions.empty.noSessionsHint')} />
              )}
            </Card>
          )}

          {canDmWrite && (showAddForm || sessions.length === 0) && (
            <AddRecapForm
              campaignId={cid}
              nextNumber={nextNumber()}
              seedRecap={aftermathRecapSeed}
              fromScheduleId={fromScheduleId}
              onCreated={(created) => {
                setShowAddForm(false);
                setSearchParams(
                  (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set('session', String(created.id));
                    next.delete('action');
                    next.delete('fromSchedule');
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
  startEditing,
  seedRecap,
  onEditActionHandled,
  onBack,
  onChange,
  onDeleted,
  detailHeadingRef,
}: {
  session: SessionListItem;
  campaignId: number;
  /** Open the existing recap editor when arriving from a post-encounter deep link. */
  startEditing: boolean;
  /** Recap body seeded from an encounter aftermath hand-off (issue #473). */
  seedRecap?: string | null;
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
  const { t } = useTranslation();
  const { me } = useAuth();
  const { isDm, canDmWrite } = useCampaignAccess();
  const [editing, setEditing] = useState(canDmWrite && startEditing);
  const [titleDraft, setTitleDraft] = useState(session.title);
  const [dateDraft, setDateDraft] = useState(toDateInputValue(session.playedAt));
  // The list omits the full recap body (issue #71) — fetch it for the opened session.
  const [recap, setRecap] = useState('');
  const [recapLoading, setRecapLoading] = useState(true);
  const [recapDraft, setRecapDraft] = useState('');
  const [dmSecretDraft, setDmSecretDraft] = useState('');
  const [recapBaseline, setRecapBaseline] = useState<RecapEditorDraft | null>(null);
  const [loadedSessionId, setLoadedSessionId] = useState<number | null>(null);
  const [linkedEncounters, setLinkedEncounters] = useState<Session['linkedEncounters']>([]);
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
    setEditing(canDmWrite && startEditing);
    setTitleDraft(session.title);
    setDateDraft(toDateInputValue(session.playedAt));
    // Issue #853: clear prior recap/draft immediately so a slow A fetch cannot leave
    // A's prose editable against B (key= remounts help; sequencer covers races).
    setRecap('');
    setRecapDraft('');
    setDmSecretDraft('');
    setRecapBaseline(null);
    setLoadedSessionId(null);
    setLinkedEncounters([]);
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
        setTitleDraft(decision.record.title);
        setDateDraft(toDateInputValue(decision.record.playedAt));
        setRecap(decision.record.recap);
        const seededRecap =
          seedRecap && startEditing && !decision.record.recap.trim() ? seedRecap : decision.record.recap;
        setRecapDraft(seededRecap);
        setDmSecretDraft(decision.record.dmSecret ?? '');
        setRecapBaseline(
          recapEditorDraftFromSession({
            title: decision.record.title,
            playedAt: decision.record.playedAt,
            recap: seededRecap,
            dmSecret: decision.record.dmSecret ?? '',
            scheduledSessionId: decision.record.scheduledSessionId ?? null,
          }),
        );
        setLoadedUpdatedAt(decision.record.updatedAt);
        setLoadedSessionId(decision.record.id);
        setLinkedEncounters(decision.record.linkedEncounters ?? []);
        setConflict(false);
      })
      .catch((err) => {
        if (!loadSequencerRef.current.isCurrent(generation, session.id)) return;
        setRecap('');
        setRecapDraft('');
        setDmSecretDraft('');
        setLoadedUpdatedAt(null);
        setLoadedSessionId(null);
        setLinkedEncounters([]);
        if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
        setError(translateApiError(err, t, { fallbackKey: 'sessions.errors.loadRecap' }));
      })
      .finally(() => {
        if (loadSequencerRef.current.isCurrent(generation, session.id)) setRecapLoading(false);
      });
    const sequencer = loadSequencerRef.current;
    return () => sequencer.invalidate();
  }, [session, canDmWrite, startEditing]);

  const detailReady = mutationsEnabledForRoute(
    loadedSessionId != null ? { id: loadedSessionId } : null,
    session.id,
    recapLoading,
  );

  const effectiveRecapBaseline = useMemo<RecapEditorDraft>(
    () =>
      recapBaseline ?? {
        title: session.title,
        playedAt: toDateInputValue(session.playedAt),
        recap: '',
        dmSecret: session.dmSecret ?? '',
        scheduledSessionId: session.scheduledSessionId ?? null,
      },
    [recapBaseline, session.title, session.playedAt, session.dmSecret, session.scheduledSessionId],
  );
  const recapCurrent = {
    title: titleDraft,
    playedAt: dateDraft,
    recap: recapDraft,
    dmSecret: dmSecretDraft,
    scheduledSessionId: session.scheduledSessionId ?? null,
  };
  const recapDirty =
    editing && detailReady && recapBaseline != null && isRecapEditorDirty(recapCurrent, effectiveRecapBaseline);
  const clearPersistedDraftRef = useRef<() => void>(() => {});

  const save = useCallback(async (): Promise<boolean> => {
    if (!assertMutationTarget(loadedSessionId, session.id).ok) return false;
    const nextErrors = validateRecapFields({
      title: titleDraft,
      playedAt: dateDraft,
      recap: recapDraft,
      dmSecret: dmSecretDraft,
    });
    setFieldErrors(nextErrors);
    const invalidId = firstInvalidRecapControlId(nextErrors, fieldIds);
    if (invalidId) {
      document.getElementById(invalidId)?.focus();
      return false;
    }

    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const updated = await api.patch<Session>(`${API}/sessions/${session.id}`, {
        title: titleDraft,
        playedAt: dateDraft ? dateDraft : null,
        recap: recapDraft,
        dmSecret: dmSecretDraft,
        ...(loadedUpdatedAt ? { expectedUpdatedAt: loadedUpdatedAt } : {}),
      });
      setRecap(updated.recap);
      setDmSecretDraft(updated.dmSecret ?? '');
      setLoadedUpdatedAt(updated.updatedAt);
      setLoadedSessionId(updated.id);
      setEditing(false);
      onEditActionHandled();
      setHistoryNonce((n) => n + 1);
      clearPersistedDraftRef.current();
      onChange();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        setError(
          e.message ||
            'This recap changed since you opened it — reload to see the latest version before saving, so you don\'t erase the other edit.',
        );
      } else {
        setError(t('sessions.errors.saveRecap'));
      }
      document.getElementById(fieldIds.title.controlId)?.focus();
      return false;
    } finally {
      setSaving(false);
    }
  }, [
    dateDraft,
    dmSecretDraft,
    fieldIds,
    loadedSessionId,
    loadedUpdatedAt,
    onChange,
    onEditActionHandled,
    recapDraft,
    session.id,
    titleDraft,
  ]);

  const protectedRecap = useProtectedForm({
    formId: `session-recap:${session.id}`,
    userId: me?.user.id,
    campaignId,
    active: editing && recapBaseline != null,
    dirty: recapDirty,
    draft: recapCurrent,
    baseline: effectiveRecapBaseline,
    serverUpdatedAt: loadedUpdatedAt,
    isDraftEqual: recapEditorDraftsEqual,
    onRestoreDraft: (restored) => {
      setTitleDraft(restored.title);
      setDateDraft(restored.playedAt);
      setRecapDraft(restored.recap);
      setDmSecretDraft(restored.dmSecret ?? '');
    },
    onDiscard: () => {
      setTitleDraft(effectiveRecapBaseline.title);
      setDateDraft(effectiveRecapBaseline.playedAt);
      setRecapDraft(effectiveRecapBaseline.recap);
      setDmSecretDraft(effectiveRecapBaseline.dmSecret ?? '');
      setEditing(false);
      setFieldErrors({});
      setError(null);
      setConflict(false);
      onEditActionHandled();
    },
    onSave: save,
  });
  clearPersistedDraftRef.current = protectedRecap.clearPersistedDraft;

  async function reloadLatest() {
    setError(null);
    setConflict(false);
    setFieldErrors({});
    setRecapLoading(true);
    try {
      const full = await api.get<Session>(`${API}/sessions/${session.id}`);
      setTitleDraft(full.title);
      setDateDraft(toDateInputValue(full.playedAt));
      setRecap(full.recap);
      setRecapDraft(full.recap);
      setDmSecretDraft(full.dmSecret ?? '');
      setRecapBaseline(
        recapEditorDraftFromSession({
          title: full.title,
          playedAt: full.playedAt,
          recap: full.recap,
          dmSecret: full.dmSecret ?? '',
          scheduledSessionId: full.scheduledSessionId ?? null,
        }),
      );
      setLoadedUpdatedAt(full.updatedAt);
      setLoadedSessionId(full.id);
    } catch {
      setError(t('sessions.errors.reloadRecap'));
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
      setError(t('sessions.errors.deleteSession'));
      setDeleting(false);
    }
  }

  return (
    <div className="reading-surface space-y-3" style={{ maxWidth: 720 }} {...entityTargetProps('session', session.id)}>
      <div>
        <button onClick={onBack} className="cf-print-hide text-xs text-secondary hover:text-[var(--color-neutral-300)] lg:hidden mb-1 block">
          ← Back to sessions
        </button>
      </div>
      {!editing && error && <ErrorNote message={error} />}
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <span className="tag tag-accent">Session {session.number}</span>
        <h2
          ref={detailHeadingRef}
          tabIndex={-1}
          // Issue #1684 sweep: focus lands here programmatically (see the
          // useEffect above) after a mobile "select a session" tap — the same
          // "pointer-driven landing" shape nocturne.css's #login-title:focus
          // comment documents, where :focus-visible's heuristic often does not
          // apply. Use plain :focus with an explicit ring (not focus:outline-none)
          // so the landing is never invisible, matching that established
          // convention instead of diverging from it.
          className="text-xl font-extrabold text-white m-0 focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-[var(--color-accent)]"
        >
          {session.title || 'Untitled session'}
        </h2>
        <span className="text-muted text-xs">{formatDate(session.playedAt)}</span>
        {!editing && (
          <PrintControl resetKey={session.id} className="ml-auto" />
        )}
      </div>

      {editing ? (
        <>
        <Card className="cf-print-editor edit-recap-form min-w-0 space-y-3">
          {protectedRecap.restorePrompt}
          {protectedRecap.leavePrompt}
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
            {canDmWrite && (
              <div className="min-w-0 space-y-1">
                <label
                  htmlFor={fieldIds.dmSecret.controlId}
                  className="block text-xs font-bold text-amber-400 uppercase tracking-wide break-words"
                >
                  <OptionalFieldLabel>{RECAP_FIELD_LABELS.dmSecret}</OptionalFieldLabel>
                </label>
                <TextArea
                  id={fieldIds.dmSecret.controlId}
                  name="dmSecret"
                  className="min-w-0 border-amber-500/30"
                  style={{ minHeight: 100 }}
                  value={dmSecretDraft}
                  onChange={(e) => {
                    setDmSecretDraft(e.target.value);
                    setFieldErrors((current) => ({ ...current, dmSecret: undefined }));
                  }}
                  placeholder="DM-only prep notes, secret curses, hidden npc motivations…"
                  aria-invalid={fieldErrors.dmSecret ? true : undefined}
                  aria-describedby={recapDescribedBy(fieldIds.dmSecret, {
                    error: Boolean(fieldErrors.dmSecret),
                  })}
                />
                <p id={fieldIds.dmSecret.helpId} className="m-0 text-xs text-slate-400 break-words">
                  {RECAP_DM_SECRET_HELP}
                </p>
                {fieldErrors.dmSecret && (
                  <p id={fieldIds.dmSecret.errorId} role="alert" className="m-0 text-xs text-rose-400">
                    {fieldErrors.dmSecret}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-wrap gap-2 justify-end items-center">
              {protectedRecap.saveStatusLabel ? (
                <span className="text-xs text-slate-400 mr-auto" role="status" aria-live="polite">
                  {protectedRecap.saveStatusLabel}
                </span>
              ) : null}
              {conflict && (
                <Btn density="xs" ghost type="button" className="text-xs" onClick={reloadLatest} disabled={saving}>
                  Reload latest
                </Btn>
              )}
              <Btn density="compact"
                ghost
                type="button"
                className="text-xs"
                onClick={() => {
                  protectedRecap.clearPersistedDraft();
                  setTitleDraft(effectiveRecapBaseline.title);
                  setDateDraft(effectiveRecapBaseline.playedAt);
                  setRecapDraft(effectiveRecapBaseline.recap);
                  setDmSecretDraft(effectiveRecapBaseline.dmSecret ?? '');
                  setEditing(false);
                  setFieldErrors({});
                  setError(null);
                  setConflict(false);
                  onEditActionHandled();
                }}
              >
                Cancel
              </Btn>
              <Btn density="compact" type="submit" className="text-xs" disabled={saving || !detailReady}>
                {saving ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          </form>
        </Card>
        {/* Browser print (Ctrl/Cmd+P) while editing should still yield the draft
            recap rather than a blank page once the editor chrome is print-hidden.
            Mount only under print media so the draft does not duplicate screen DOM. */}
        <PrintOnly>
          <Card className="cf-print-only cf-print-paper min-w-0">
            {recapDraft.trim() ? (
              <Markdown>{recapDraft}</Markdown>
            ) : (
              <p className="text-sm">No recap written yet.</p>
            )}
          </Card>
        </PrintOnly>
        </>
      ) : (
        <div className="space-y-3">
          <Card>
            {recapLoading ? (
              <Skeleton lines={4} label="Loading recap…" />
            ) : recap ? (
              <Markdown>{recap}</Markdown>
            ) : (
              <p className="text-sm text-secondary">No recap written yet.</p>
            )}
          </Card>
          {isDm && (session.dmSecret || dmSecretDraft) ? (
            <Card className="border border-amber-500/30 bg-amber-500/5">
              <div className="text-xs font-bold text-amber-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <span>🔒</span> DM Prep Notes (DM-Only)
              </div>
              <Markdown>{session.dmSecret || dmSecretDraft}</Markdown>
            </Card>
          ) : null}
        </div>
      )}

      {!editing && (
        <div className="cf-print-hide">
          <AttendancePanel sessionId={session.id} campaignId={session.campaignId} scheduledSessionId={session.scheduledSessionId} />
        </div>
      )}

      {canDmWrite && !editing && (
        <div className="cf-print-hide flex gap-2">
          <Btn density="xs" ghost className="text-xs" onClick={() => setEditing(true)}>
            Edit recap
          </Btn>
          <Btn density="xs" danger ghost className="text-xs" onClick={() => setConfirmingDelete(true)} busy={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Btn>
        </div>
      )}

      {!editing && (
        <div className="cf-print-hide">
          <SharePanel sessionId={session.id} campaignId={campaignId} />
        </div>
      )}

      {/* Recap revision history + restore (issue #157) — DM-only, so a clobbered or
          regretted edit can be recovered. Refetches whenever a save/restore happens. */}
      {canDmWrite && !editing && (
        <div className="cf-print-hide">
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
        </div>
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
      <div className="cf-print-hide">
        <EncounterBacklinksCard campaignId={campaignId} encounters={linkedEncounters ?? []} />
        <EntityDiscussion campaignId={campaignId} entityType="session" entityId={session.id} />
      </div>
    </div>
  );
}

/**
 * Session attendance (issue #121) — the "who was there" record for a session.
 * Everyone sees the attendee chips; a DM gets a roster picker to toggle which
 * characters played (replace-set PUT). West Marches / rotating-cast tables need
 * this because the party is otherwise all-or-nothing.
 */
function AttendancePanel({
  sessionId,
  campaignId,
  scheduledSessionId,
}: {
  sessionId: number;
  campaignId: number;
  scheduledSessionId?: number | null;
}) {
  const { t } = useTranslation();
  const { canDmWrite } = useCampaignAccess();
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
      if (next.length === 0 && scheduledSessionId) {
        try {
          const sch = await api.get<ScheduledSessionWithRsvps>(`${API}/schedule/${scheduledSessionId}`, { signal });
          const yesUserIds = new Set((sch.rsvps ?? []).filter((r) => r.status === 'yes').map((r) => String(r.userId)));
          if (yesUserIds.size > 0) {
            const chars = await api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`, { signal });
            const matchedIds = chars
              .filter((c) => c.ownerUserId && yesUserIds.has(String(c.ownerUserId)))
              .map((c) => c.id);
            if (matchedIds.length > 0 && canDmWrite) {
              const seeded = await api.put<SessionAttendee[]>(`${API}/sessions/${sessionId}/attendance`, {
                characterIds: matchedIds,
              });
              if (loadSequencerRef.current.isCurrent(generation, sessionId)) {
                setAttendees(seeded);
                setLoadedForSessionId(sessionId);
                return;
              }
            }
          }
        } catch {
          // ignore auto-seed failures
        }
      }
      setAttendees(next);
      setLoadedForSessionId(sessionId);
    } catch (err) {
      if (!loadSequencerRef.current.isCurrent(generation, sessionId)) return;
      setAttendees([]);
      setLoadedForSessionId(null);
      if ((err as { name?: string } | undefined)?.name === 'AbortError') return;
      // Attendance is a non-critical embellishment — surface retry via the empty state.
      setError(t('sessions.errors.loadAttendance'));
    } finally {
      if (loadSequencerRef.current.isCurrent(generation, sessionId)) setLoading(false);
    }
  }, [sessionId, campaignId, scheduledSessionId, canDmWrite]);

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
        setError(t('sessions.errors.loadRoster'));
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
      setError(t('sessions.errors.saveAttendance'));
    } finally {
      setSaving(false);
    }
  }

  if (loading || !attendanceReady) {
    return <SkeletonConditionalRegion preset="attendance" />;
  }

  return (
    <Card className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-secondary uppercase tracking-wide">Who played</span>
        <div className="flex-1" />
        {canDmWrite && !editing && (
          <Btn density="xs" ghost className="text-xs" onClick={startEditing}>
            {attendees.length ? 'Edit' : 'Set attendance'}
          </Btn>
        )}
      </div>

      {error && <ErrorNote message={error} />}

      {editing ? (
        <div className="space-y-2">
          {roster.length === 0 ? (
            <p className="text-sm text-secondary">No characters in this campaign yet.</p>
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
            <Btn density="compact" ghost className="text-xs" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Btn>
            <Btn density="compact" className="text-xs" onClick={save} disabled={saving || !attendanceReady}>
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
        <p className="text-sm text-secondary">Attendance not recorded.</p>
      )}
    </Card>
  );
}

type ShareLifetime = '1' | '7' | '30' | 'never';

/** Member-visible status plus DM-only capability controls for one recap. */
function SharePanel({ sessionId, campaignId }: { sessionId: number; campaignId: number }) {
  const { t } = useTranslation();
  const { canDmWrite } = useCampaignAccess();
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
      setError(t('sessions.errors.loadShareLinks'));
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
      setNewLink({ shareId: res.share.id, url: `${window.location.origin}${joinPublicBase('/share/')}${res.token}` });
      setLabel('');
      setLifetime('7');
      setAcknowledgedNever(false);
      await load();
    } catch {
      setError(t('sessions.errors.createShareLink'));
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

      {canDmWrite && policyEnabled && (
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
          <Btn density="xs"
            className="text-xs !bg-violet-700 !border-violet-700 !text-white"
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
          <CopyControl density="xs"
            text={newLink.url}
            selectTargetId={newLinkId}
            label="Copy link"
            copiedLabel="Copied ✓"
            ghost
            className="text-xs shrink-0"
            successAnnouncement="Share link copied to clipboard."
            failureAnnouncement="Copy failed. Clipboard blocked — select the link and copy it manually."
          />
        </div>
      )}

      {loading ? (
        <Skeleton lines={2} />
      ) : shares.length === 0 ? (
        <p className="text-sm text-secondary m-0">No active links.</p>
      ) : (
        <ul className="m-0 p-0 space-y-2" style={{ listStyle: 'none' }}>
          {shares.map((s) => (
            <ShareRow
              key={s.id}
              share={s}
              sessionId={sessionId}
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
  onChanged,
  onRevoked,
}: {
  share: SessionShare;
  sessionId: number;
  onChanged: () => Promise<void>;
  onRevoked: (shareId: number) => void;
}) {
  const { t } = useTranslation();
  const { canDmWrite } = useCampaignAccess();
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
      const action =
        kind === 'revoke' ? t('sessions.shareActions.revoke') : kind === 'extend' ? t('sessions.shareActions.extend') : t('sessions.shareActions.rename');
      setError(t('sessions.errors.shareLinkAction', { action }));
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
      {canDmWrite && (
        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <label className="sr-only" htmlFor={`share-row-label-${share.id}`}>Edit share label</label>
          <TextInput density="xs"
            id={`share-row-label-${share.id}`}
            className="text-xs flex-1"
            maxLength={120}
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
          />
          <Btn density="xs" ghost className="text-xs" busy={busy === 'label'} disabled={busy !== null || draftLabel === share.label} onClick={() => void mutate('label')}>
            {busy === 'label' ? 'Saving…' : 'Save label'}
          </Btn>
          {share.expiresAt && (
            <Btn density="xs" ghost className="text-xs" busy={busy === 'extend'} disabled={busy !== null} onClick={() => void mutate('extend')}>
              {busy === 'extend' ? 'Extending…' : 'Extend 7 days'}
            </Btn>
          )}
          <Btn density="xs" danger ghost className="text-xs" busy={busy === 'revoke'} disabled={busy !== null} onClick={() => void mutate('revoke')}>
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
  seedRecap,
  fromScheduleId,
  onCreated,
  onCancel,
}: {
  campaignId: number;
  nextNumber: number;
  seedRecap?: string | null;
  fromScheduleId?: number | null;
  onCreated: (session: Session) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { canDmWrite } = useCampaignAccess();
  const [title, setTitle] = useState('');
  const [playedAt, setPlayedAt] = useState(() => localDateInputValue());
  const dateWasEdited = useRef(false);
  const dateFieldFocusedRef = useRef(false);
  const [recap, setRecap] = useState(() => seedRecap ?? '');
  const [dmSecret, setDmSecret] = useState('');
  const [scheduledSessionId, setScheduledSessionId] = useState<number | null>(fromScheduleId ?? null);
  const [scheduleRsvps, setScheduleRsvps] = useState<SessionRsvp[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<RecapFieldErrors>({});
  const fieldIds = newRecapFieldIds();
  const newRecapDraft = { title, playedAt, recap, dmSecret, scheduledSessionId };
  const newRecapDirty = title.trim() !== '' || recap.trim() !== '' || dmSecret.trim() !== '' || dateWasEdited.current;

  useEffect(() => {
    if (!fromScheduleId) return;
    api
      .get<ScheduledSessionWithRsvps>(`${API}/schedule/${fromScheduleId}`)
      .then((sch) => {
        if (!sch) return;
        if (sch.title) setTitle(sch.title);
        if (sch.scheduledAt) {
          setPlayedAt(sch.scheduledAt.slice(0, 10));
          dateWasEdited.current = true;
        }
        if (sch.notes && !seedRecap) setRecap(sch.notes);
        setScheduledSessionId(sch.id);
        setScheduleRsvps(sch.rsvps ?? []);
      })
      .catch(() => {
        // ignore load error for schedule prefill
      });
  }, [fromScheduleId, seedRecap]);

  const publish = useCallback(async (): Promise<boolean> => {
    const nextErrors = validateRecapFields({ title, playedAt, recap, dmSecret });
    setFieldErrors(nextErrors);
    const invalidId = firstInvalidRecapControlId(nextErrors, fieldIds);
    if (invalidId) {
      document.getElementById(invalidId)?.focus();
      return false;
    }

    setSaving(true);
    setError(null);
    try {
      const created = await api.post<Session>(`${API}/campaigns/${campaignId}/sessions`, {
        number: nextNumber,
        title: title.trim(),
        playedAt: playedAt || null,
        recap,
        dmSecret: dmSecret.trim(),
        scheduledSessionId,
      });

      if (scheduledSessionId && scheduleRsvps.length > 0) {
        const yesUserIds = new Set(
          scheduleRsvps.filter((r) => r.status === 'yes').map((r) => String(r.userId)),
        );
        if (yesUserIds.size > 0) {
          try {
            const characters = await api.get<Character[]>(`${API}/campaigns/${campaignId}/characters`);
            const matchedIds = characters
              .filter((c) => c.ownerUserId && yesUserIds.has(String(c.ownerUserId)))
              .map((c) => c.id);
            if (matchedIds.length > 0) {
              await api.put(`${API}/sessions/${created.id}/attendance`, { characterIds: matchedIds });
            }
          } catch {
            // non-fatal attendance seeding error
          }
        }
      }

      setTitle('');
      setRecap('');
      setDmSecret('');
      setFieldErrors({});
      onCreated(created);
      return true;
    } catch {
      setError(t('sessions.errors.publishRecap'));
      document.getElementById(fieldIds.title.controlId)?.focus();
      return false;
    } finally {
      setSaving(false);
    }
  }, [campaignId, dmSecret, fieldIds, nextNumber, onCreated, playedAt, recap, scheduleRsvps, scheduledSessionId, t, title]);

  const protectedNewRecap = useProtectedForm({
    formId: 'session-recap-new',
    userId: me?.user.id,
    campaignId,
    active: true,
    dirty: newRecapDirty,
    draft: newRecapDraft,
    baseline: EMPTY_RECAP_EDITOR_DRAFT,
    isDraftEqual: recapEditorDraftsEqual,
    onRestoreDraft: (restored) => {
      setTitle(restored.title);
      setPlayedAt(restored.playedAt);
      setRecap(restored.recap);
      setDmSecret(restored.dmSecret ?? '');
      dateWasEdited.current = restored.playedAt.trim() !== '';
    },
    onSave: publish,
  });

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

  return (
    <Card className="new-recap-form min-w-0 space-y-3">
      {protectedNewRecap.restorePrompt}
      {protectedNewRecap.leavePrompt}
      <h2 className="font-bold text-white text-sm">+ Add recap (Session {nextNumber})</h2>
      {error && (
        <div id={fieldIds.formErrorId}>
          <ErrorNote message={error} onRetry={() => { void publish(); }} />
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
            onFocus={() => {
              dateFieldFocusedRef.current = true;
            }}
            onBlur={(e) => {
              const next = e.target.value;
              if (dateFieldFocusedRef.current && next === '' && !dateWasEdited.current) {
                dateWasEdited.current = true;
                setPlayedAt('');
              }
              dateFieldFocusedRef.current = false;
            }}
            onChange={(e) => {
              const next = e.target.value;
              if (next === '' && !dateWasEdited.current) return;
              dateWasEdited.current = true;
              setPlayedAt(next);
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
        {canDmWrite && (
          <div className="min-w-0 space-y-1">
            <label
              htmlFor={fieldIds.dmSecret.controlId}
              className="block text-xs font-bold text-amber-400 uppercase tracking-wide break-words"
            >
              <OptionalFieldLabel>{RECAP_FIELD_LABELS.dmSecret}</OptionalFieldLabel>
            </label>
            <TextArea
              id={fieldIds.dmSecret.controlId}
              name="dmSecret"
              className="min-w-0 border-amber-500/30"
              style={{ minHeight: 80 }}
              value={dmSecret}
              onChange={(e) => {
                setDmSecret(e.target.value);
                setFieldErrors((current) => ({ ...current, dmSecret: undefined }));
              }}
              placeholder="DM-only prep notes, secret curses, hidden npc motivations…"
              aria-invalid={fieldErrors.dmSecret ? true : undefined}
              aria-describedby={recapDescribedBy(fieldIds.dmSecret, {
                error: Boolean(fieldErrors.dmSecret),
              })}
            />
            <p id={fieldIds.dmSecret.helpId} className="m-0 text-xs text-slate-400 break-words">
              {RECAP_DM_SECRET_HELP}
            </p>
            {fieldErrors.dmSecret && (
              <p id={fieldIds.dmSecret.errorId} role="alert" className="m-0 text-xs text-rose-400">
                {fieldErrors.dmSecret}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-[11px] text-slate-400 break-words">
            {protectedNewRecap.saveStatusLabel ? (
              <span role="status" aria-live="polite">{protectedNewRecap.saveStatusLabel}</span>
            ) : (
              <>
                Tip: start from the template, or ask your AI scribe to <em>"draft a recap from this session"</em>.
              </>
            )}
          </p>
          {/* compact, not xs (issue #1692 review — Codex + repo owner): "Publish recap"
              is this form's primary submit action, not a dense inline row/toolbar
              control — the UiDensity contract this PR adds explicitly reserves xs
              for the latter. compact also better matches the original !py-2 sizing
              here, which was already more generous than the !py-1/!py-1.5 sites
              that became xs elsewhere in this codemod. */}
          <div className="flex flex-wrap gap-2 sm:shrink-0">
            {onCancel && (
              <Btn density="compact"
                ghost
                type="button"
                className="text-sm"
                onClick={() => {
                  protectedNewRecap.clearPersistedDraft();
                  onCancel();
                }}
              >
                Cancel
              </Btn>
            )}
            <Btn density="compact" type="submit" className="text-sm" disabled={saving}>
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
    <Btn density="xs"
      ghost
      type="button"
      className="text-xs"
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
