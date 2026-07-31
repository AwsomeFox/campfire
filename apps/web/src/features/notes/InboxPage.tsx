/**
 * Scribe inbox — mirrors design/claude-design/Campfire.dc.html "Scribe inbox" (~1105-1124).
 * Route: /c/:campaignId/inbox (DM only; non-dm gets a friendly notice).
 * Design: avatar + text + "from X", a "Resolve →" action per pending item. We keep the
 * existing expand-to-add-a-resolution-note flow (extra functionality) behind that action,
 * and resolving may optionally link the entity the item became (quest/npc/location/…).
 *
 * Two views: "Open" (unresolved items, GET /campaigns/:cid/inbox) and "History"
 * (resolved items, GET /campaigns/:cid/inbox?resolved=true) — history shows each
 * item's resolution note and a link to the entity it was resolved into.
 *
 * Pagination (issue #608): both lists return `{ items, total, hasMore, nextCursor }`
 * newest-first, where `nextCursor` is always present and `null` on the terminal page;
 * load-more appends; page-aware errors keep prior rows visible.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { InboxSweepItemResult, InboxSweepResult, Note, NoteListPage } from '@campfire/schema';
import { NOTES_LIST_DEFAULT_LIMIT } from '@campfire/schema';
import { api, API, ApiError, translateApiError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { useCampaign } from '../../app/CampaignContext';
import { archivedWriteBlockedReason } from '../../app/campaignAccess';
import { bumpPendingProposalsBadge, setPendingProposalsBadge, setInboxCountBadge } from '../../lib/proposalsBadgeBus';
import { Card, Chip, Btn, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { GameIcon } from '../../components/GameIcon';
import { TermHelp } from '../../components/TermHelp';
import { firstGrapheme } from '../../lib/avatarText';
import { ENTITY_ICON, UI_ICON_SIZE } from '../../lib/uiIcons';
import { entityHref as targetHref, entityTargetProps } from '../../lib/entityLinks';
import { buildNoteBodiesMap, resolveSweepItemBody } from './inboxSweepLookup';

interface InboxListState {
  items: Note[];
  total: number;
  hasMore: boolean;
  nextCursor?: string | null;
}

const EMPTY_LIST: InboxListState = { items: [], total: 0, hasMore: false };

type EntityTypeValue = Exclude<Note['entityType'], null>;
type ViewValue = 'open' | 'history';

const entityIcon: Record<EntityTypeValue, string> = {
  quest: ENTITY_ICON.quest,
  npc: ENTITY_ICON.npc,
  faction: ENTITY_ICON.faction,
  location: ENTITY_ICON.location,
  character: ENTITY_ICON.character,
  session: ENTITY_ICON.session,
  encounter: ENTITY_ICON.encounter,
  campaign: ENTITY_ICON.campaign,
};

/** Entity types the resolve form offers as link targets (campaign excluded — nothing "becomes" the campaign). */
const LINKABLE: { value: EntityTypeValue; label: string; listPath: string }[] = [
  { value: 'quest', label: 'Quest', listPath: 'quests' },
  { value: 'npc', label: 'NPC', listPath: 'npcs' },
  { value: 'location', label: 'Location', listPath: 'locations' },
  { value: 'session', label: 'Session', listPath: 'sessions' },
  { value: 'character', label: 'Character', listPath: 'characters' },
];

interface EntityOption {
  id: number;
  label: string;
}

function optionLabel(type: EntityTypeValue, row: Record<string, unknown>): string {
  if (type === 'session') {
    const title = typeof row.title === 'string' && row.title ? ` — ${row.title}` : '';
    return `Session ${String(row.number ?? row.id)}${title}`;
  }
  const name = row.title ?? row.name;
  return typeof name === 'string' && name ? name : `#${String(row.id)}`;
}

export default function InboxPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  // Live pointer to the currently-viewed campaign, for async callbacks (the sweep
  // request below) that need to detect a campaign switch that happened while they
  // were in flight — a plain closure over `cid` only ever sees the value from the
  // render that started the request, never a later one.
  const cidRef = useRef(cid);
  cidRef.current = cid;
  // Monotonically increments for each sweep start; lets later code ignore completions
  // that belong to an older run after the user switched campaigns or re-triggered.
  const sweepTokenRef = useRef(0);
  const { isDm, canDmWrite } = useCampaignAccess();
  const campaign = useCampaign(Number.isFinite(cid) ? cid : undefined);
  const [searchParams] = useSearchParams();
  const inboxParam = searchParams.get('inbox');
  const deepInboxId = inboxParam != null && inboxParam !== '' ? Number(inboxParam) : Number.NaN;

  const [view, setView] = useState<ViewValue>('open');
  const [openList, setOpenList] = useState<InboxListState>(EMPTY_LIST);
  const [historyList, setHistoryList] = useState<InboxListState>(EMPTY_LIST);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const fetchGeneration = useRef(0);

  // Inbox sweep (issue #1646) — a real DM-facing control for the server orchestration
  // that already shipped (#1644). Kept as component state rather than folded into the
  // load()/error state above: a sweep result is its own "session" (a completed run's
  // outcome), not part of the open/history lists, and must survive load() refreshing
  // those lists underneath it.
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepResult, setSweepResult] = useState<InboxSweepResult | null>(null);
  const [sweepItemBodies, setSweepItemBodies] = useState<Record<number, string>>({});
  const [sweepError, setSweepError] = useState<string | null>(null);

  const inboxUrl = useCallback(
    (resolved: boolean, cursor?: string) => {
      const params = new URLSearchParams();
      params.set('limit', String(NOTES_LIST_DEFAULT_LIMIT));
      if (resolved) params.set('resolved', 'true');
      if (cursor) params.set('cursor', cursor);
      return `${API}/campaigns/${cid}/inbox?${params.toString()}`;
    },
    [cid],
  );

  // Returns the fresh open total on success (undefined if superseded/failed) — sweepInbox
  // uses this to push Layout's inbox badge the authoritative post-sweep count (issue
  // #1679 review) without a second round-trip just for a number it already fetched here.
  const load = useCallback(async (): Promise<number | undefined> => {
    const gen = ++fetchGeneration.current;
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const [open, resolved] = await Promise.all([
        api.get<NoteListPage>(inboxUrl(false)),
        api.get<NoteListPage>(inboxUrl(true)),
      ]);
      if (gen !== fetchGeneration.current) return undefined;
      setOpenList({
        items: open.items,
        total: open.total,
        hasMore: open.hasMore,
        nextCursor: open.nextCursor,
      });
      setHistoryList({
        items: resolved.items,
        total: resolved.total,
        hasMore: resolved.hasMore,
        nextCursor: resolved.nextCursor,
      });
      return open.total;
    } catch (e) {
      if (gen !== fetchGeneration.current) return undefined;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError(t('notes.inboxCouldntLoad'));
      }
      return undefined;
    } finally {
      if (gen === fetchGeneration.current) setLoading(false);
    }
  }, [inboxUrl, t]);

  const loadMore = useCallback(async () => {
    const active = view === 'open' ? openList : historyList;
    if (!active.nextCursor || loadingMore || loading) return;
    const gen = fetchGeneration.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.get<NoteListPage>(inboxUrl(view === 'history', active.nextCursor));
      if (gen !== fetchGeneration.current) return;
      const merge = (prev: InboxListState): InboxListState => {
        const seen = new Set(prev.items.map((n) => n.id));
        return {
          items: [...prev.items, ...page.items.filter((n) => !seen.has(n.id))],
          total: page.total,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        };
      };
      if (view === 'open') setOpenList(merge);
      else setHistoryList(merge);
    } catch (e) {
      if (gen !== fetchGeneration.current) return;
      setError(e instanceof ApiError ? e.message : t('notes.inboxCouldntLoadMore'));
    } finally {
      setLoadingMore(false);
    }
  }, [view, openList, historyList, loadingMore, loading, inboxUrl, t]);

  useEffect(() => {
    if (Number.isFinite(cid) && isDm) void load();
  }, [cid, isDm, load]);

  // The campaign switcher reuses this route component (issue #1679 review) — cid
  // changes without InboxPage unmounting. Sweep result/error/body state is
  // campaign-scoped (a sweep outcome from campaign A means nothing once the DM has
  // switched to campaign B), so clear it whenever cid changes rather than leaving
  // the previous campaign's outcome card visible indefinitely. Also release the
  // busy flag: an in-flight sweep's finally block intentionally skips state updates
  // once cidRef.current has moved on, but that leaves sweepBusy stuck true.
  useEffect(() => {
    sweepTokenRef.current++;
    setSweepBusy(false);
    setSweepResult(null);
    setSweepItemBodies({});
    setSweepError(null);
  }, [cid]);

  // Notification deep-links use /inbox?inbox=:id#entity-inbox-:id. Resolved rows
  // only render under History, so switch the tab before EntityDeepLinkFocus runs.
  const deepFetchRef = useRef<number | null>(null);
  useEffect(() => {
    if (!Number.isFinite(deepInboxId)) return;
    if (openList.items.some((item) => item.id === deepInboxId)) {
      setView('open');
      setExpandedId(deepInboxId);
      return;
    }
    if (historyList.items.some((item) => item.id === deepInboxId)) {
      setView('history');
      return;
    }
    // With default pagination the deep-linked item can live beyond the first loaded page.
    // Once the initial load settles, fetch it directly (once) so the correct tab opens and
    // the row renders/expands even when it's not on page one.
    if (loading || deepFetchRef.current === deepInboxId) return;
    deepFetchRef.current = deepInboxId;
    let cancelled = false;
    void api
      .get<Note>(`${API}/notes/${deepInboxId}`)
      .then((note) => {
        if (cancelled || note.kind !== 'inbox') return;
        // Insert in sort order (not at the front): a deep-linked item is usually OLDER than
        // the loaded first page, so prepending would break the documented newest-first order.
        const inject =
          (cmp: (a: Note, b: Note) => number) =>
          (prev: InboxListState): InboxListState =>
            prev.items.some((i) => i.id === note.id)
              ? prev
              : { ...prev, items: [...prev.items, note].sort(cmp) };
        if (note.resolved) {
          // History is ordered by resolution recency (updatedAt desc, id desc).
          setView('history');
          setHistoryList(
            inject((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '') || b.id - a.id),
          );
        } else {
          // Open is ordered by newest-first creation (createdAt desc, id desc).
          setView('open');
          setOpenList(
            inject((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || b.id - a.id),
          );
        }
        setExpandedId(deepInboxId);
      })
      .catch(() => {
        // Deep-linked note no longer exists or read forbidden — ignore.
      });
    return () => {
      cancelled = true;
    };
  }, [deepInboxId, openList.items, historyList.items, loading]);

  async function resolve(item: Note, resolvedNote: string, link: { entityType: EntityTypeValue; entityId: number } | null) {
    try {
      await api.post(`${API}/notes/${item.id}/resolve`, {
        resolvedNote,
        ...(link ? { entityType: link.entityType, entityId: link.entityId } : {}),
      });
      await load();
      setExpandedId(null);
    } catch {
      setError(t('notes.inboxCouldntResolve'));
    }
  }

  // Long-running (issue #1646): the endpoint classifies every open capture before it
  // responds, so this can take a while with a large inbox. `sweepBusy` disables the
  // trigger for the whole duration (no double-fire) and the button's own label switches
  // to a "working" state — see the render below — rather than the page looking inert.
  async function sweepInbox() {
    if (sweepBusy) return;
    // Captured so a completion that lands after the DM has switched campaigns or started
    // a new sweep (issue #1679 review) can be told apart from the latest active sweep run.
    const sweepCid = cid;
    const sweepToken = ++sweepTokenRef.current;
    setSweepBusy(true);
    setSweepError(null);
    setSweepResult(null);
    // Snapshot bodies for the items about to be swept — the sweep call resolves them,
    // so by the time the result comes back they've fallen out of openList (the reload
    // below moves them to history). Keeping this snapshot across both open and history
    // lists provides fallback titles when an item outcome lacks a server body.
    setSweepItemBodies(buildNoteBodiesMap(openList.items, historyList.items));
    try {
      const result = await api.post<InboxSweepResult>(`${API}/campaigns/${sweepCid}/inbox/sweep`);
      if (sweepCid !== cidRef.current || sweepToken !== sweepTokenRef.current) return;
      setSweepResult(result);
      // Server-truth reconciliation still happens on the next route change (Layout's
      // effect); this just makes the badge catch up without waiting for that.
      // Use newlyProposed so a re-swept/recovered prior row doesn't inflate the badge;
      // fall back to a delta bump for mocked/legacy responses that don't include it.
      const newlyProposed = result.job.itemsNewlyProposed;
      if (newlyProposed === undefined) {
        const delta = result.job.itemsProposed;
        if (delta > 0 && sweepToken === sweepTokenRef.current) bumpPendingProposalsBadge(delta, sweepCid);
      }
      const freshOpenTotal = await load();
      if (sweepCid === cidRef.current && sweepToken === sweepTokenRef.current && freshOpenTotal !== undefined) {
        setInboxCountBadge(freshOpenTotal, sweepCid);
      }
      // After a real sweep, re-fetch the authoritative pending count so concurrent
      // sweeps (where the losing side gets a recovered outcome with itemsNewlyProposed 0)
      // don't leave the badge stale or double-counted.
      if (sweepCid === cidRef.current && sweepToken === sweepTokenRef.current && newlyProposed !== undefined) {
        try {
          const pending = await api.get<unknown[]>(`${API}/campaigns/${sweepCid}/proposals?status=pending`);
          if (sweepCid === cidRef.current && sweepToken === sweepTokenRef.current) {
            setPendingProposalsBadge(pending.length, sweepCid);
          }
        } catch (err) {
          console.warn('[InboxPage] Failed to reconcile proposals badge after sweep', err);
          if (newlyProposed > 0 && sweepCid === cidRef.current && sweepToken === sweepTokenRef.current) {
            bumpPendingProposalsBadge(newlyProposed, sweepCid);
          }
        }
      }
    } catch (e) {
      if (sweepCid !== cidRef.current || sweepToken !== sweepTokenRef.current) return;
      setSweepError(translateApiError(e, t, { fallbackKey: 'notes.sweepFailed' }));
    } finally {
      if (sweepCid === cidRef.current && sweepToken === sweepTokenRef.current) setSweepBusy(false);
    }
  }

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message={t('notes.noCampaign')} />
      </div>
    );
  }

  if (!isDm) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="top-hat" title={t('notes.dmOnlyTitle')} hint={t('notes.dmOnlyHint')} />
        </Card>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <Card>
          <EmptyState icon="padlock" title={t('notes.noAccess')} />
        </Card>
      </div>
    );
  }

  // Precedence: archived beats "nothing to sweep" — an archived campaign is disabled
  // for a reason the DM can't fix by resolving items, so that's the more useful message.
  // "nothing to sweep" is also gated on the initial load having settled (issue #1679
  // review): openList starts at EMPTY_LIST (total 0) while loading is true, so without
  // this a DM opening a large/slow inbox briefly sees a false "the inbox is empty"
  // message and disabled button before the real count arrives. Disable-without-a-
  // misleading-reason during that window instead.
  const sweepDisabledReason = !canDmWrite
    ? archivedWriteBlockedReason(campaign)
    : loading
      ? null
      : openList.total === 0
        ? t('notes.sweepNothingToSweep')
        : null;

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-3 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-xl font-extrabold text-white m-0">{t('notes.inboxTitle')}</h1>
        <TermHelp termId="scribe" />
      </div>
      <p className="text-muted text-xs m-0">
        {t('notes.inboxIntro')}
      </p>
      <p className="text-muted text-xs m-0">
        {t('notes.inboxMcpNote')}{' '}
        <Link to="/tokens" className="text-purple-400 hover:underline">
          {t('notes.inboxMcpNoteLinkLabel')}
        </Link>
        .
      </p>

      <SweepControl
        busy={sweepBusy}
        disabledReason={sweepDisabledReason}
        // canDmWrite is false both when the campaign is genuinely archived (covered by
        // sweepDisabledReason's text above) AND, momentarily, while `campaign` (loaded
        // separately via useCampaign) hasn't resolved yet — archivedWriteBlockedReason
        // returns null for the latter, which would otherwise leave the button enabled
        // with write access still unconfirmed (issue #1679 review). Hard-disable on
        // !canDmWrite regardless of whether there's a reason to show yet.
        hardDisabled={!canDmWrite}
        onSweep={() => void sweepInbox()}
      />
      {sweepError && <ErrorNote message={sweepError} onRetry={() => void sweepInbox()} />}
      {sweepResult && (
        <SweepResultCard
          campaignId={cid}
          result={sweepResult}
          itemBodies={sweepItemBodies}
          knownNotes={buildNoteBodiesMap(openList.items, historyList.items)}
          onDismiss={() => setSweepResult(null)}
        />
      )}

      <div className="flex gap-1.5 flex-wrap">
        <button onClick={() => setView('open')}>
          <Chip variant={view === 'open' ? 'active' : 'available'}>
            {t('notes.tabOpen')}
            {openList.total > 0 ? ` (${openList.total})` : ''}
          </Chip>
        </button>
        <button onClick={() => setView('history')}>
          <Chip variant={view === 'history' ? 'active' : 'available'}>
            {t('notes.tabHistory')}
            {historyList.total > 0 ? ` (${historyList.total})` : ''}
          </Chip>
        </button>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      {loading && openList.items.length === 0 && historyList.items.length === 0 ? (
        <Card>
          <Skeleton lines={4} />
        </Card>
      ) : view === 'open' ? (
        openList.items.length === 0 ? (
          <EmptyState icon="envelope" title={t('notes.inboxClearTitle')} hint={t('notes.inboxClearHint')} />
        ) : (
          <div className="space-y-3">
            {openList.items.map((item) => (
              <InboxItem
                key={item.id}
                campaignId={cid}
                item={item}
                canWrite={canDmWrite}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                onResolve={(note, link) => resolve(item, note, link)}
                onDismiss={() => resolve(item, 'dismissed', null)}
              />
            ))}
          </div>
        )
      ) : historyList.items.length === 0 ? (
        <EmptyState icon="archive-register" title={t('notes.noHistoryTitle')} hint={t('notes.noHistoryHint')} />
      ) : (
        <div className="space-y-3">
          {historyList.items.map((item) => (
            <ResolvedItem key={item.id} campaignId={cid} item={item} />
          ))}
        </div>
      )}

      {(() => {
        const active = view === 'open' ? openList : historyList;
        return (
          <>
            {active.items.length > 0 && (
              <p className="text-[11px] text-secondary m-0" aria-live="polite">
                {active.hasMore || active.total > active.items.length
                  ? t('notes.inboxShowingOf', { shown: active.items.length, total: active.total })
                  : t('notes.showingAll', { count: active.items.length })}
              </p>
            )}
            {active.hasMore && (
              <div className="flex justify-center pt-1">
                <Btn density="xs"
                  type="button"
                  ghost
                  className="text-xs"
                  disabled={loadingMore || loading}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? t('notes.inboxLoadingMore') : t('notes.inboxLoadMore')}
                </Btn>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

/**
 * The sweep trigger (issue #1646) — a real DM control for the server orchestration
 * (#1644) that already reads every open item, infers create/update/dismiss, and files
 * each as a pending proposal. `disabledReason`, when set, both disables the button and
 * is shown as the reason (archived campaign, or nothing open to sweep) rather than
 * leaving the DM to guess why it's greyed out.
 */
function SweepControl({
  busy,
  disabledReason,
  hardDisabled = false,
  onSweep,
}: {
  busy: boolean;
  disabledReason: string | null;
  /** Disable the control even when there's no text reason to show yet (e.g. write
   *  access not confirmed while the campaign is still loading). */
  hardDisabled?: boolean;
  onSweep: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cf-inset p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <Btn density="compact" className="text-xs" onClick={onSweep} disabled={busy || disabledReason !== null || hardDisabled}>
          {busy ? t('notes.sweepButtonBusy') : t('notes.sweepButton')}
        </Btn>
        <p className="text-[11px] text-secondary m-0 flex-1 min-w-0">{t('notes.sweepHint')}</p>
      </div>
      {/* aria-live: the only feedback while a sweep is in flight — it can take a while
          for a large inbox, so this is what tells the DM the button did something
          rather than the page just looking stuck (issue #1646). */}
      {busy && (
        <p className="text-[11px] text-amber-200 m-0" aria-live="polite">
          {t('notes.sweepInProgress')}
        </p>
      )}
      {!busy && disabledReason && (
        <p className="text-[11px] text-secondary m-0">{disabledReason}</p>
      )}
    </div>
  );
}

const SWEEP_OUTCOME_TAG: Record<InboxSweepItemResult['outcome'], { cls: string; labelKey: string }> = {
  proposed: { cls: 'tag tag-accent', labelKey: 'notes.sweepOutcomeProposed' },
  skipped: { cls: 'tag tag-neutral', labelKey: 'notes.sweepOutcomeSkipped' },
  errored: { cls: 'tag', labelKey: 'notes.sweepOutcomeErrored' },
};

/**
 * Sweep outcome (issue #1646). The server force-skips unsupported captures (objective
 * ticks, HP/combat writes) with a stated `reason` regardless of what the classifier
 * decided — that reason MUST reach the DM here, not just the job totals, or a
 * considered "couldn't do this because X" reads as an indistinguishable silent
 * failure. Every item in `result.items` renders its `reason` unconditionally, for
 * every outcome (proposed/skipped/errored alike).
 */
function SweepResultCard({
  campaignId,
  result,
  itemBodies,
  knownNotes,
  onDismiss,
}: {
  campaignId: number;
  result: InboxSweepResult;
  itemBodies?: Record<number, string>;
  knownNotes?: Record<number, string>;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const { job, items } = result;

  return (
    <Card density="default" className="space-y-2.5">
      {job.status === 'disabled' && (
        <div className="cf-inset p-3 space-y-1.5 border-amber-600/40">
          <p className="m-0 text-sm text-amber-200">{job.detail || t('notes.sweepNoProvider')}</p>
          <div className="flex items-center gap-3">
            <Link to={`/c/${campaignId}/settings#ai-dm-provider`} className="text-xs text-purple-400 hover:underline">
              {t('notes.sweepOpenAiSettings')}
            </Link>
            <button type="button" className="text-xs text-secondary hover:text-white" onClick={onDismiss}>
              {t('notes.sweepDismiss')}
            </button>
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="m-0 text-sm">
          {t('notes.sweepSummary', {
            total: job.itemsTotal,
            proposed: job.itemsProposed,
            skipped: job.itemsSkipped,
            errored: job.itemsErrored,
          })}
        </p>
        {job.status !== 'disabled' && (
          <button type="button" className="text-xs text-secondary hover:text-white shrink-0" onClick={onDismiss}>
            {t('notes.sweepDismiss')}
          </button>
        )}
      </div>
      {job.itemsProposed > 0 && (
        <Link to={`/c/${campaignId}/proposals`} className="text-xs text-purple-400 hover:underline">
          {t('notes.sweepReviewProposals')}
        </Link>
      )}
      {items.length === 0 ? (
        <p className="text-xs text-secondary m-0">{t('notes.sweepNothingToSweep')}</p>
      ) : (
        <ul className="m-0 p-0 space-y-2" style={{ listStyle: 'none' }}>
          {items.map((item) => {
            const tag = SWEEP_OUTCOME_TAG[item.outcome];
            const body = resolveSweepItemBody(item, itemBodies, knownNotes);
            return (
              <li key={item.noteId} className="cf-inset p-2.5 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={tag.cls} style={{ fontSize: 10 }}>
                    {t(tag.labelKey)}
                  </span>
                  <span className="text-[11px] text-secondary truncate">
                    {body ? body : t('notes.sweepItemFallbackLabel', { noteId: item.noteId })}
                  </span>
                </div>
                {/* The stated reason — always rendered, every outcome (see doc comment above). */}
                <p className="text-xs text-slate-400 m-0">{item.reason}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function entityHref(campaignId: number, item: Note): string | null {
  if (!item.entityType) return null;
  return targetHref(campaignId, { type: item.entityType, id: item.entityId });
}

function ResolvedItem({ campaignId, item }: { campaignId: number; item: Note }) {
  const { t } = useTranslation();
  const href = entityHref(campaignId, item);
  const resolvedOn = item.updatedAt ? formatDate(item.updatedAt) : null;
  return (
    <Card density="default" className="space-y-2.5" {...entityTargetProps('inbox', item.id)}>
      <div className="flex gap-2.5 items-start">
        <span className="h-[30px] w-[30px] shrink-0 rounded-full bg-[var(--color-neutral-900)] flex items-center justify-center text-[11px] text-[var(--color-neutral-400)]">
          {firstGrapheme(item.authorName || '?')}
        </span>
        <div className="flex-1 min-w-0">
          <Markdown>{item.body}</Markdown>
          <p className="text-muted text-[11px] mt-0.5 mb-0">
            {t('notes.fromAuthor', { name: item.authorName || 'Someone' })}
            {resolvedOn && <> · {t('notes.resolvedLabel')} {resolvedOn}</>}
          </p>
        </div>
      </div>

      <div className="cf-inset p-3 space-y-1.5">
        <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest m-0">{t('notes.resolvedInto')}</p>
        {item.entityType && href && (
          <Link to={href} className="inline-flex items-center gap-1.5 text-xs text-purple-400 hover:underline">
            <GameIcon slug={entityIcon[item.entityType]} size={UI_ICON_SIZE.xs} /> {capitalize(item.entityType)}
            {item.entityId !== null && item.entityType !== 'campaign' ? ` #${item.entityId}` : ''} →
          </Link>
        )}
        {item.resolvedNote ? (
          <p className="text-xs text-slate-400 m-0">{item.resolvedNote}</p>
        ) : (
          !item.entityType && <p className="text-xs text-secondary m-0">{t('notes.noResolutionNote')}</p>
        )}
      </div>
    </Card>
  );
}

function capitalize(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

function InboxItem({
  campaignId,
  item,
  canWrite,
  expanded,
  onToggle,
  onResolve,
  onDismiss,
}: {
  campaignId: number;
  item: Note;
  canWrite: boolean;
  expanded: boolean;
  onToggle: () => void;
  onResolve: (resolvedNote: string, link: { entityType: EntityTypeValue; entityId: number } | null) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [resolutionNote, setResolutionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkType, setLinkType] = useState<EntityTypeValue | ''>('');
  const [linkId, setLinkId] = useState<number | ''>('');
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  useEffect(() => {
    setLinkId('');
    setOptions([]);
    if (!linkType) return;
    const meta = LINKABLE.find((l) => l.value === linkType);
    if (!meta) return;
    let cancelled = false;
    setOptionsLoading(true);
    api
      .get<Record<string, unknown>[]>(`${API}/campaigns/${campaignId}/${meta.listPath}`)
      .then((rows) => {
        if (cancelled) return;
        setOptions(rows.map((row) => ({ id: Number(row.id), label: optionLabel(linkType, row) })));
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [linkType, campaignId]);

  const busyRef = useRef(false);

  async function runAction(action: () => Promise<void>): Promise<void> {
    // State updates are not synchronous: the ref also closes the same-tick gap
    // where two activations can arrive before React renders disabled controls.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function handleResolve(): Promise<void> {
    return runAction(() =>
      onResolve(resolutionNote.trim(), linkType && linkId !== '' ? { entityType: linkType, entityId: linkId } : null),
    );
  }

  function handleDismiss(): Promise<void> {
    return runAction(onDismiss);
  }

  return (
    <Card density="default" className={`space-y-2.5 ${expanded ? 'border-amber-500/40' : ''}`} {...entityTargetProps('inbox', item.id)}>
      <div className="flex gap-2.5 items-start">
        <span className="h-[30px] w-[30px] shrink-0 rounded-full bg-[var(--color-neutral-900)] flex items-center justify-center text-[11px] text-[var(--color-neutral-400)]">
          {firstGrapheme(item.authorName || '?')}
        </span>
        <div className="flex-1 min-w-0">
          <Markdown>{item.body}</Markdown>
          <p className="text-muted text-[11px] mt-0.5 mb-0">{t('notes.fromAuthor', { name: item.authorName || 'Someone' })}</p>
        </div>
      </div>

      {expanded && canWrite && (
        <div className="cf-inset p-3 space-y-2.5 border-amber-500/30">
          <p className="text-[10px] font-bold text-amber-500 uppercase tracking-widest">{t('notes.resolveInto')}</p>
          <TextArea
            style={{ minHeight: 70 }}
            value={resolutionNote}
            onChange={(e) => setResolutionNote(e.target.value)}
            placeholder={t('notes.resolutionPlaceholder')}
            disabled={busy}
          />
          <div className="flex gap-2 flex-wrap">
            <select
              className="cf-select text-xs cf-density-xs"
              value={linkType}
              onChange={(e) => setLinkType(e.target.value as EntityTypeValue | '')}
              disabled={busy}
            >
              <option value="">{t('notes.noEntityLink')}</option>
              {LINKABLE.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            {linkType && (
              <select
                className="cf-select text-xs flex-1 min-w-0 cf-density-xs"
                value={linkId}
                onChange={(e) => setLinkId(e.target.value === '' ? '' : Number(e.target.value))}
                disabled={busy || optionsLoading}
              >
                <option value="">{optionsLoading ? t('notes.loading') : options.length === 0 ? t('notes.nothingToLink') : t('notes.pickOne')}</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex items-center justify-between pt-1 gap-2 flex-wrap">
            <p className="text-[11px] text-secondary">
              {t('notes.resolvePreamble')}{linkType && linkId !== '' ? t('notes.resolveLinked') : t('notes.resolveNote')}.
            </p>
            <div className="flex gap-2 shrink-0">
              <Btn density="xs" ghost className="text-xs" onClick={handleDismiss} disabled={busy}>
                {t('notes.dismiss')}
              </Btn>
              <Btn density="xs" className="text-xs" onClick={handleResolve} disabled={busy}>
                {t('notes.resolve')}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {canWrite && (
      <div className="flex justify-end">
        <Btn density="xs" className="text-xs" onClick={onToggle} disabled={busy}>
          {expanded ? t('notes.collapse') : t('notes.resolveArrow')}
        </Btn>
      </div>
      )}
    </Card>
  );
}
