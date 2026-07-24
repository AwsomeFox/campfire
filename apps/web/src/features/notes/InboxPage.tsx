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
import type { Note, NoteListPage } from '@campfire/schema';
import { NOTES_LIST_DEFAULT_LIMIT } from '@campfire/schema';
import { api, API, ApiError } from '../../lib/api';
import { useAuth } from '../../app/auth';
import { Card, Chip, Btn, TextArea, EmptyState, Skeleton, ErrorNote } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { GameIcon } from '../../components/GameIcon';
import { firstGrapheme } from '../../lib/avatarText';
import { ENTITY_ICON } from '../../lib/uiIcons';
import { entityHref as targetHref, entityTargetProps } from '../../lib/entityLinks';

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
  const { roleIn } = useAuth();
  const role = roleIn(cid);
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

  const load = useCallback(async () => {
    const gen = ++fetchGeneration.current;
    setError(null);
    setForbidden(false);
    setLoading(true);
    try {
      const [open, resolved] = await Promise.all([
        api.get<NoteListPage>(inboxUrl(false)),
        api.get<NoteListPage>(inboxUrl(true)),
      ]);
      if (gen !== fetchGeneration.current) return;
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
    } catch (e) {
      if (gen !== fetchGeneration.current) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setForbidden(true);
      } else {
        setError(t('notes.inboxCouldntLoad'));
      }
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
    if (Number.isFinite(cid) && role === 'dm') void load();
  }, [cid, role, load]);

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
          // Open items are ordered newest-first by id.
          setView('open');
          setOpenList(inject((a, b) => b.id - a.id));
          setExpandedId(note.id);
        }
      })
      .catch(() => {
        /* not accessible / not found — leave the loaded lists as-is */
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

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-3xl mx-auto px-4 mt-5">
        <ErrorNote message={t('notes.noCampaign')} />
      </div>
    );
  }

  if (role !== null && role !== 'dm') {
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

  return (
    <div className="max-w-3xl mx-auto px-4 mt-5 space-y-3 pb-20 md:pb-10" style={{ maxWidth: 760 }}>
      <h1 className="text-xl font-extrabold text-white m-0">{t('notes.inboxTitle')}</h1>
      <p className="text-muted text-xs m-0">
        {t('notes.inboxIntro')}
      </p>
      <p className="text-muted text-xs m-0">
        &quot;Claude&quot; here means any MCP-capable assistant (like Claude) connected with an API token — set one
        up in <Link to="/tokens" className="text-purple-400 hover:underline">API tokens</Link>.
      </p>

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

      {error && <ErrorNote message={error} onRetry={load} />}

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
              <p className="text-[11px] text-slate-500 m-0" aria-live="polite">
                {active.hasMore || active.total > active.items.length
                  ? t('notes.inboxShowingOf', { shown: active.items.length, total: active.total })
                  : t('notes.showingAll', { count: active.items.length })}
              </p>
            )}
            {active.hasMore && (
              <div className="flex justify-center pt-1">
                <Btn
                  type="button"
                  ghost
                  className="!min-h-0 !py-1.5 text-xs"
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

function entityHref(campaignId: number, item: Note): string | null {
  if (!item.entityType) return null;
  return targetHref(campaignId, { type: item.entityType, id: item.entityId });
}

function ResolvedItem({ campaignId, item }: { campaignId: number; item: Note }) {
  const { t } = useTranslation();
  const href = entityHref(campaignId, item);
  const resolvedOn = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : null;
  return (
    <Card className="!p-4 space-y-2.5" {...entityTargetProps('inbox', item.id)}>
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
            <GameIcon slug={entityIcon[item.entityType]} size={13} /> {capitalize(item.entityType)}
            {item.entityId !== null && item.entityType !== 'campaign' ? ` #${item.entityId}` : ''} →
          </Link>
        )}
        {item.resolvedNote ? (
          <p className="text-xs text-slate-400 m-0">{item.resolvedNote}</p>
        ) : (
          !item.entityType && <p className="text-xs text-slate-500 m-0">{t('notes.noResolutionNote')}</p>
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
  expanded,
  onToggle,
  onResolve,
  onDismiss,
}: {
  campaignId: number;
  item: Note;
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
    <Card className={`!p-4 space-y-2.5 ${expanded ? 'border-amber-500/40' : ''}`} {...entityTargetProps('inbox', item.id)}>
      <div className="flex gap-2.5 items-start">
        <span className="h-[30px] w-[30px] shrink-0 rounded-full bg-[var(--color-neutral-900)] flex items-center justify-center text-[11px] text-[var(--color-neutral-400)]">
          {firstGrapheme(item.authorName || '?')}
        </span>
        <div className="flex-1 min-w-0">
          <Markdown>{item.body}</Markdown>
          <p className="text-muted text-[11px] mt-0.5 mb-0">{t('notes.fromAuthor', { name: item.authorName || 'Someone' })}</p>
        </div>
      </div>

      {expanded && (
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
              className="cf-select !min-h-0 !py-2 text-xs"
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
                className="cf-select !min-h-0 !py-2 text-xs flex-1 min-w-0"
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
            <p className="text-[11px] text-slate-500">
              {t('notes.resolvePreamble')}{linkType && linkId !== '' ? t('notes.resolveLinked') : t('notes.resolveNote')}.
            </p>
            <div className="flex gap-2 shrink-0">
              <Btn ghost className="!min-h-0 !py-1.5 text-xs" onClick={handleDismiss} disabled={busy}>
                {t('notes.dismiss')}
              </Btn>
              <Btn className="!min-h-0 !py-1.5 text-xs" onClick={handleResolve} disabled={busy}>
                {t('notes.resolve')}
              </Btn>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Btn className="!min-h-0 !py-1.5 text-xs" onClick={onToggle} disabled={busy}>
          {expanded ? t('notes.collapse') : t('notes.resolveArrow')}
        </Btn>
      </div>
    </Card>
  );
}
