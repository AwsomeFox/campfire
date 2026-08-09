/**
 * /c/:campaignId/audit — full paginated campaign audit log (issue #443).
 *
 * Cursor pagination, date/actor/action/entity filters, deep-linkable query params,
 * CSV export, loading/error states, and virtualized rendering for long histories.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AuditEntry, AuditListPage, CampaignMember, TrashedEntity } from '@campfire/schema';
import { AUDIT_LIST_DEFAULT_LIMIT } from '@campfire/schema';
import { api, API, getWithHeaders, translateApiError } from '../../lib/api';
import { useCampaignAccess } from '../../app/CampaignAccessContext';
import { Btn, Card, EmptyState, ErrorNote, Skeleton } from '../../components/ui';
import { VirtualList } from '../../components/VirtualList';
import { GameIcon } from '../../components/GameIcon';
import {
  AUDIT_CSV_HEADER,
  AuditEntryRow,
  auditEntryToCsvRow,
} from './campaignAuditDisplay';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

type AuditFilters = {
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  since: string;
  until: string;
};

const EMPTY_FILTERS: AuditFilters = {
  action: '',
  actor: '',
  entityType: '',
  entityId: '',
  since: '',
  until: '',
};

const ENTITY_TYPES = [
  'quest',
  'npc',
  'location',
  'faction',
  'character',
  'session',
  'encounter',
  'note',
  'campaign',
] as const;

function dateInputToSinceTs(date: string): string | undefined {
  if (!date) return undefined;
  return `${date}T00:00:00.000Z`;
}

function dateInputToUntilTs(date: string): string | undefined {
  if (!date) return undefined;
  return `${date}T23:59:59.999Z`;
}

function filtersFromSearchParams(params: URLSearchParams): AuditFilters {
  return {
    action: params.get('action') ?? '',
    actor: params.get('actor') ?? '',
    entityType: params.get('entityType') ?? '',
    entityId: params.get('entityId') ?? '',
    since: params.get('since') ?? '',
    until: params.get('until') ?? '',
  };
}

function filtersToSearchParams(filters: AuditFilters, highlightId?: number | null): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.action) params.set('action', filters.action);
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.entityType) params.set('entityType', filters.entityType);
  if (filters.entityId) params.set('entityId', filters.entityId);
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  if (highlightId != null && Number.isFinite(highlightId)) params.set('entry', String(highlightId));
  return params;
}

function buildAuditUrl(
  campaignId: number,
  filters: AuditFilters,
  cursor?: string | null,
): string {
  const params = new URLSearchParams();
  params.set('envelope', '1');
  params.set('limit', String(AUDIT_LIST_DEFAULT_LIMIT));
  if (cursor) params.set('cursor', cursor);
  if (filters.action) params.set('action', filters.action);
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.entityType) params.set('entityType', filters.entityType);
  if (filters.entityId) params.set('entityId', filters.entityId);
  const sinceTs = dateInputToSinceTs(filters.since);
  const untilTs = dateInputToUntilTs(filters.until);
  if (sinceTs) params.set('sinceTs', sinceTs);
  if (untilTs) params.set('untilTs', untilTs);
  return `${API}/campaigns/${campaignId}/audit?${params.toString()}`;
}

export default function CampaignAuditPage() {
  const { t } = useTranslation();
  const { campaignId } = useParams<{ campaignId: string }>();
  const cid = Number(campaignId);
  const { isDm } = useCampaignAccess();
  const [searchParams, setSearchParams] = useSearchParams();

  const [filters, setFilters] = useState<AuditFilters>(() => filtersFromSearchParams(searchParams));
  const [draftFilters, setDraftFilters] = useState<AuditFilters>(() => filtersFromSearchParams(searchParams));
  const [members, setMembers] = useState<CampaignMember[]>([]);
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [trashedTimelineEventIds, setTrashedTimelineEventIds] = useState<ReadonlySet<number> | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retention, setRetention] = useState<{ days: number | null; autoPrune: boolean } | null>(null);
  const fetchGeneration = useRef(0);
  const highlightId = Number(searchParams.get('entry'));

  useEffect(() => {
    const next = filtersFromSearchParams(searchParams);
    setFilters(next);
    setDraftFilters(next);
  }, [searchParams]);

  useEffect(() => {
    if (!Number.isFinite(cid) || !isDm) return;
    void api.get<CampaignMember[]>(`${API}/campaigns/${cid}/members`).then(setMembers).catch(() => setMembers([]));
  }, [cid, isDm]);

  useEffect(() => {
    let active = true;
    if (!Number.isFinite(cid) || !isDm) {
      setTrashedTimelineEventIds(null);
      return () => {
        active = false;
      };
    }
    setTrashedTimelineEventIds(null);
    void api
      .get<TrashedEntity[]>(`${API}/campaigns/${cid}/trash`)
      .then((items) => {
        if (active) setTrashedTimelineEventIds(new Set(items.filter((item) => item.type === 'timeline_event').map((item) => item.id)));
      })
      .catch(() => {
        if (active) setTrashedTimelineEventIds(null);
      });
    return () => {
      active = false;
    };
  }, [cid, isDm]);

  const loadPage = useCallback(
    async (activeFilters: AuditFilters, cursor?: string | null, append = false) => {
      const gen = ++fetchGeneration.current;
      if (append) setLoadingMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const { data: page, headers } = await getWithHeaders<AuditListPage>(buildAuditUrl(cid, activeFilters, cursor));
        if (gen !== fetchGeneration.current) return;
        const days = headers.get('X-Audit-Retention-Days');
        setRetention({
          days: days === 'unlimited' ? null : days != null && Number.isFinite(Number(days)) ? Number(days) : null,
          autoPrune: headers.get('X-Audit-Auto-Prune') === '1',
        });
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setTotal(page.total);
        setHasMore(page.hasMore);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (gen !== fetchGeneration.current) return;
        setError(translateApiError(err, t, { fallbackKey: 'admin.errors.loadAuditLog' }));
        if (!append) setItems([]);
      } finally {
        if (gen === fetchGeneration.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [cid, t],
  );

  useEffect(() => {
    if (!Number.isFinite(cid) || !isDm) return;
    void loadPage(filters);
  }, [cid, isDm, filters, loadPage]);

  useEffect(() => {
    if (!Number.isFinite(highlightId)) return;
    const el = document.getElementById(`audit-${highlightId}`);
    el?.scrollIntoView({ block: 'center' });
  }, [highlightId, items.length]);

  const actorOptions = useMemo(() => {
    const opts = members.map((m) => ({
      value: String(m.userId),
      label: m.displayName || m.username || `#${m.userId}`,
    }));
    return opts;
  }, [members]);

  const applyFilters = () => {
    const params = filtersToSearchParams(draftFilters);
    setSearchParams(params, { replace: true });
  };

  const clearFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setSearchParams({}, { replace: true });
  };

  const exportCsv = async () => {
    setExporting(true);
    setError(null);
    try {
      const rows: AuditEntry[] = [];
      let nextCursor: string | null = null;
      let more = true;
      while (more) {
        const auditPage: AuditListPage = await api.get<AuditListPage>(buildAuditUrl(cid, filters, nextCursor));
        rows.push(...auditPage.items);
        more = auditPage.hasMore;
        nextCursor = auditPage.nextCursor;
      }

      const body = [AUDIT_CSV_HEADER, ...rows.map((e) => auditEntryToCsvRow(e, members))].join('\n');
      const blob = new Blob([body], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `campaign-${cid}-audit.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'errors.loadFailed' }));
    } finally {
      setExporting(false);
    }
  };

  if (!Number.isFinite(cid)) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <ErrorNote message={t('common.noCampaign')} />
      </div>
    );
  }

  if (!isDm) {
    return (
      <div className="max-w-4xl mx-auto px-4 mt-5">
        <Card className="text-center space-y-1">
          <p className="flex justify-center text-[var(--color-neutral-400)]">
            <GameIcon slug="padlock" size={28} reserveSpace />
          </p>
          <p className="text-sm text-slate-300 font-semibold">Audit log is DM-only</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 mt-5 space-y-4 pb-20 md:pb-10">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <h1 className="flex items-center gap-2 text-xl font-extrabold text-white m-0">
          <GameIcon slug="scroll-unfurled" size={UI_ICON_SIZE.md} /> Audit log
        </h1>
        <Link to={`/c/${cid}/members`} className="text-[11px] text-secondary hover:text-white">
          ← Members
        </Link>
      </div>

      <Card className="space-y-1 border-amber-500/30 bg-amber-500/5">
        <p className="text-xs font-semibold text-amber-200 m-0">Audit retention disclosure</p>
        <p className="text-[11px] text-slate-300 m-0">
          {retention
            ? retention.days === null
              ? `Audit history is configured to be kept indefinitely. Auto-prune is ${retention.autoPrune ? 'enabled' : 'off'}.`
              : `Audit history defaults to ${retention.days} days. Auto-prune is ${retention.autoPrune ? 'enabled' : 'off'}; server admins can preview, archive, and prune from Admin -> Audit log.`
            : 'Loading the current audit retention policy...'}
        </p>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-bold text-white text-sm border-b border-slate-700 pb-2">Filters</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
          <label className="space-y-1">
            <span className="text-secondary">Action</span>
            <input
              className="cf-input w-full"
              value={draftFilters.action}
              onChange={(e) => setDraftFilters((f) => ({ ...f, action: e.target.value }))}
              placeholder="e.g. quest.update"
            />
          </label>
          <label className="space-y-1">
            <span className="text-secondary">Actor</span>
            <select
              className="cf-input w-full"
              value={draftFilters.actor}
              onChange={(e) => setDraftFilters((f) => ({ ...f, actor: e.target.value }))}
            >
              <option value="">Any</option>
              {actorOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-secondary">Entity type</span>
            <select
              className="cf-input w-full"
              value={draftFilters.entityType}
              onChange={(e) => setDraftFilters((f) => ({ ...f, entityType: e.target.value }))}
            >
              <option value="">Any</option>
              {ENTITY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-secondary">Entity id</span>
            <input
              className="cf-input w-full"
              inputMode="numeric"
              value={draftFilters.entityId}
              onChange={(e) => setDraftFilters((f) => ({ ...f, entityId: e.target.value }))}
              placeholder="Optional"
            />
          </label>
          <label className="space-y-1">
            <span className="text-secondary">From</span>
            <input
              type="date"
              className="cf-input w-full"
              value={draftFilters.since}
              onChange={(e) => setDraftFilters((f) => ({ ...f, since: e.target.value }))}
            />
          </label>
          <label className="space-y-1">
            <span className="text-secondary">Until</span>
            <input
              type="date"
              className="cf-input w-full"
              value={draftFilters.until}
              onChange={(e) => setDraftFilters((f) => ({ ...f, until: e.target.value }))}
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn type="button" onClick={applyFilters}>
            Apply filters
          </Btn>
          <Btn type="button" ghost onClick={clearFilters}>
            Clear
          </Btn>
          <Btn type="button" ghost onClick={() => void exportCsv()} disabled={exporting || loading}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Btn>
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between border-b border-slate-700 pb-2">
          <h2 className="font-bold text-white text-sm m-0">Activity</h2>
          <span className="text-[11px] text-secondary" role="status">
            {loading && items.length === 0
              ? 'Loading…'
              : total > 0
                ? `Showing ${items.length} of ${total}`
                : 'No entries'}
          </span>
        </div>

        {error && !items.length ? <ErrorNote message={error} onRetry={() => void loadPage(filters)} /> : null}
        {error && items.length > 0 ? <p className="text-xs text-rose-400 m-0">{error}</p> : null}

        {loading && items.length === 0 ? (
          <Skeleton lines={5} />
        ) : items.length === 0 ? (
          <EmptyState icon="scroll-unfurled" title={t('admin.empty.noActivity')} />
        ) : (
          <>
            <div role="list" aria-label="Audit log entries">
            <VirtualList items={items} estimateHeight={52} maxHeight="min(70vh, 640px)" className="space-y-2">
              {(entry) => (
                <AuditEntryRow
                  key={entry.id}
                  entry={entry}
                  members={members}
                  highlighted={entry.id === highlightId}
                  trashedTimelineEventIds={trashedTimelineEventIds}
                />
              )}
            </VirtualList>
            </div>
            {hasMore && (
              <Btn density="xs"
                ghost
                type="button"
                className="text-xs w-full"
                onClick={() => void loadPage(filters, nextCursor, true)}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load older entries'}
              </Btn>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
