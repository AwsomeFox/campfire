import { useTranslation } from 'react-i18next';
/**
 * /admin/campaigns — the server-admin campaign catalog (issue #587).
 *
 * Replaces "join a campaign to find it" with a paged, filterable index of every
 * campaign on the server. What it shows is metadata ONLY — counts, bytes, dates,
 * module, primary DM, policy flags — because the server route behind it reads nothing
 * else. A campaign's name and description are privacy-gated and may arrive redacted;
 * the table badges that rather than pretending `Campaign #42` is a real name.
 *
 * Paging and filtering are server-side (`?limit`/`?offset`/`?q`/…), deliberately: the
 * unpaginated tile grid on HomePage is one of the findings this issue was raised
 * about, and reproducing it here at fleet scale would miss the point.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CampaignCatalogBulkOperation,
  CampaignCatalogBulkResult,
  CampaignCatalogEntry,
  CampaignCatalogPage,
  CampaignCatalogPrivacyPolicy,
  CampaignCatalogSort,
} from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { Btn, Card, Chip, ErrorNote, EmptyState, Skeleton, TextInput } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { PageTitle } from '../../components/PageTitle';
import { RequireServerAdmin } from './RequireServerAdmin';
import {
  CATALOG_PAGE_SIZE,
  EMPTY_FILTERS,
  availableOperations,
  buildCatalogQuery,
  currentPage,
  isNoOpResult,
  outcomeVariant,
  pageCount,
  storageLabel,
  type CatalogFilters,
} from './adminCatalogState';

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

function AdminCatalog() {
  const { t } = useTranslation();
  const [page, setPage] = useState<CampaignCatalogPage | null>(null);
  const [policy, setPolicy] = useState<CampaignCatalogPrivacyPolicy | null>(null);
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [draftQuery, setDraftQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<CampaignCatalogSort>('activity');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [operation, setOperation] = useState<CampaignCatalogBulkOperation>('archive');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<CampaignCatalogBulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = buildCatalogQuery(filters, { offset, limit: CATALOG_PAGE_SIZE, sort, order });
      const [rows, pol] = await Promise.all([
        api.get<CampaignCatalogPage>(`${API}/admin/campaigns?${query}`),
        api.get<CampaignCatalogPrivacyPolicy>(`${API}/admin/campaigns/privacy`),
      ]);
      setPage(rows);
      setPolicy(pol);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'admin.errors.loadCampaigns' }));
    } finally {
      setLoading(false);
    }
  }, [filters, offset, sort, order, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => page?.items ?? [], [page]);
  const selectedEntries = useMemo(() => items.filter((c) => selected.has(c.id)), [items, selected]);
  const operations = useMemo(() => availableOperations(selectedEntries), [selectedEntries]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreview(null);
  };

  const applyFilters = (next: Partial<CatalogFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setOffset(0);
    setSelected(new Set());
    setPreview(null);
  };

  const runBulk = useCallback(
    async (dryRun: boolean) => {
      if (selectedEntries.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.post<CampaignCatalogBulkResult>(`${API}/admin/campaigns/bulk`, {
          operation,
          campaignIds: selectedEntries.map((c) => c.id),
          dryRun,
          reason,
        });
        setPreview(result);
        if (!dryRun) {
          setSelected(new Set());
          await load();
        }
      } catch (err) {
        setError(translateApiError(err, t, { fallbackKey: 'admin.errors.bulkCampaigns' }));
      } finally {
        setBusy(false);
      }
    },
    [operation, reason, selectedEntries, load, t],
  );

  if (loading && !page) {
    return (
      <div className="max-w-6xl mx-auto px-4 mt-5 space-y-5">
        <Card>
          <Skeleton lines={6} />
        </Card>
      </div>
    );
  }

  if (error && !page) {
    return (
      <div className="max-w-6xl mx-auto px-4 mt-5">
        <ErrorNote message={error} onRetry={load} />
      </div>
    );
  }

  const total = page?.total ?? 0;

  return (
    <div className="max-w-6xl mx-auto px-4 mt-5 space-y-5 pb-20 md:pb-10">
      <PageTitle className="flex items-center gap-2 text-xl font-extrabold text-white">
        <GameIcon slug="scroll-quill" size={20} aria-hidden /> {t('admin.catalog.title')}
      </PageTitle>
      <p className="text-xs text-secondary">{t('admin.catalog.subtitle')}</p>

      {error && <ErrorNote message={error} onRetry={load} />}

      <Card className="space-y-3">
        <h2 className="text-sm font-bold text-white">{t('admin.catalog.filtersHeading')}</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-1 text-xs text-secondary">
            {t('admin.catalog.search')}
            <TextInput
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilters({ q: draftQuery });
              }}
              placeholder={t('admin.catalog.searchPlaceholder')}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-secondary">
            {t('admin.catalog.status')}
            <select
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
              value={filters.status}
              onChange={(e) => applyFilters({ status: e.target.value as CatalogFilters['status'] })}
            >
              <option value="">{t('admin.catalog.statusAny')}</option>
              <option value="active">{t('admin.catalog.statusActive')}</option>
              <option value="paused">{t('admin.catalog.statusPaused')}</option>
              <option value="completed">{t('admin.catalog.statusCompleted')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-secondary">
            {t('admin.catalog.module')}
            <select
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
              value={filters.moduleInstalled}
              onChange={(e) =>
                applyFilters({ moduleInstalled: e.target.value as CatalogFilters['moduleInstalled'] })
              }
            >
              <option value="">{t('admin.catalog.moduleAny')}</option>
              <option value="true">{t('admin.catalog.moduleInstalled')}</option>
              <option value="false">{t('admin.catalog.moduleMissing')}</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-secondary">
            <input
              type="checkbox"
              checked={filters.overQuota}
              onChange={(e) => applyFilters({ overQuota: e.target.checked })}
            />
            {t('admin.catalog.overQuota')}
          </label>
          <label className="flex items-center gap-1.5 text-xs text-secondary">
            <input
              type="checkbox"
              checked={filters.trashed}
              onChange={(e) => applyFilters({ trashed: e.target.checked })}
            />
            {t('admin.catalog.trashed')}
          </label>
          <Btn onClick={() => applyFilters({ q: draftQuery })}>{t('admin.catalog.applyFilters')}</Btn>
        </div>
        {policy && (
          <p className="text-xs text-secondary">
            {t('admin.catalog.privacyPolicy', { names: policy.names, descriptions: policy.descriptions })}
          </p>
        )}
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-bold text-white">
            {t('admin.catalog.resultsHeading', { total })}
          </h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-secondary flex items-center gap-1">
              {t('admin.catalog.sortBy')}
              <select
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as CampaignCatalogSort);
                  setOffset(0);
                }}
              >
                <option value="activity">{t('admin.catalog.sortActivity')}</option>
                <option value="name">{t('admin.catalog.sortName')}</option>
                <option value="status">{t('admin.catalog.sortStatus')}</option>
                <option value="storage">{t('admin.catalog.sortStorage')}</option>
                <option value="nextSession">{t('admin.catalog.sortNextSession')}</option>
                <option value="created">{t('admin.catalog.sortCreated')}</option>
                <option value="id">{t('admin.catalog.sortId')}</option>
              </select>
            </label>
            <Btn ghost onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}>
              {order === 'asc' ? t('admin.catalog.orderAsc') : t('admin.catalog.orderDesc')}
            </Btn>
          </div>
        </div>

        {items.length === 0 ? (
          <EmptyState title={t('admin.catalog.emptyTitle')} hint={t('admin.catalog.emptyHint')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('admin.catalog.tableCaption')}</caption>
              <thead>
                <tr className="text-left text-secondary">
                  <th scope="col" className="py-2 pr-2 font-bold">
                    <span className="sr-only">{t('admin.catalog.colSelect')}</span>
                  </th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colName')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colStatus')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colModule')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colDm')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colMembers')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colNextSession')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colStorage')}</th>
                  <th scope="col" className="py-2 pr-4 font-bold">{t('admin.catalog.colActivity')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {items.map((entry: CampaignCatalogEntry) => (
                  <tr key={entry.id}>
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={selected.has(entry.id)}
                        onChange={() => toggle(entry.id)}
                        aria-label={t('admin.catalog.selectRow', { id: entry.id })}
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <span className="text-white">{entry.name}</span>
                      {entry.nameRedacted && (
                        <span title={t('admin.catalog.redactedHint')}>
                          <Chip variant="private">{t('admin.catalog.redacted')}</Chip>
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{entry.status}</td>
                    <td className="py-2 pr-4">
                      {entry.module.slug === '' ? '—' : entry.module.slug}
                      {entry.module.slug !== '' && !entry.module.installed && (
                        <Chip variant="failed">{t('admin.catalog.moduleMissingChip')}</Chip>
                      )}
                    </td>
                    <td className="py-2 pr-4">{entry.primaryDm?.displayName || entry.primaryDm?.username || '—'}</td>
                    <td className="py-2 pr-4">{entry.memberCount}</td>
                    <td className="py-2 pr-4">{shortDate(entry.nextSessionAt)}</td>
                    <td className="py-2 pr-4">
                      {storageLabel(entry)}
                      {entry.overQuota && <Chip variant="failed">{t('admin.catalog.overQuotaChip')}</Chip>}
                    </td>
                    <td className="py-2 pr-4">{shortDate(entry.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-secondary">
            {t('admin.catalog.pageOf', {
              page: currentPage(offset, CATALOG_PAGE_SIZE),
              pages: pageCount(total, CATALOG_PAGE_SIZE),
            })}
          </span>
          <div className="flex gap-2">
            <Btn ghost disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - CATALOG_PAGE_SIZE))}>
              {t('admin.catalog.prev')}
            </Btn>
            <Btn ghost disabled={!page?.hasMore} onClick={() => setOffset(offset + CATALOG_PAGE_SIZE)}>
              {t('admin.catalog.next')}
            </Btn>
          </div>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-bold text-white">
          {t('admin.catalog.bulkHeading', { count: selectedEntries.length })}
        </h2>
        <p className="text-xs text-secondary">{t('admin.catalog.bulkHint')}</p>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="flex flex-col gap-1 text-xs text-secondary">
            {t('admin.catalog.bulkOperation')}
            <select
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
              value={operation}
              onChange={(e) => {
                setOperation(e.target.value as CampaignCatalogBulkOperation);
                setPreview(null);
              }}
            >
              {operations.map((op) => (
                <option key={op} value={op}>
                  {t(`admin.catalog.op.${op}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-secondary flex-1 min-w-[200px]">
            {t('admin.catalog.bulkReason')}
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Btn disabled={busy || selectedEntries.length === 0} onClick={() => void runBulk(true)}>
            {t('admin.catalog.dryRun')}
          </Btn>
          <Btn
            disabled={busy || preview === null || preview.dryRun === false}
            onClick={() => void runBulk(false)}
          >
            {t('admin.catalog.apply')}
          </Btn>
        </div>

        {preview && (
          <div className="space-y-2">
            <p className="text-xs text-secondary">
              {preview.dryRun
                ? t('admin.catalog.dryRunSummary', {
                    wouldApply: preview.wouldApply,
                    skipped: preview.skipped,
                    failed: preview.failed,
                  })
                : t('admin.catalog.appliedSummary', {
                    applied: preview.applied,
                    skipped: preview.skipped,
                    failed: preview.failed,
                  })}
            </p>
            {isNoOpResult(preview) && <p className="text-xs text-amber-300">{t('admin.catalog.noOpHint')}</p>}
            <ul className="text-xs space-y-1">
              {preview.results.map((r) => (
                <li key={r.campaignId} className="flex items-center gap-2">
                  <Chip variant={outcomeVariant(r.outcome)}>{t(`admin.catalog.outcome.${r.outcome}`)}</Chip>
                  <span className="text-secondary">
                    #{r.campaignId}
                    {r.field ? ` · ${r.field}: ${r.before || '—'} → ${r.after || '—'}` : ''}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AdminCatalogPage() {
  useTranslation();
  return (
    <RequireServerAdmin>
      <AdminCatalog />
    </RequireServerAdmin>
  );
}
