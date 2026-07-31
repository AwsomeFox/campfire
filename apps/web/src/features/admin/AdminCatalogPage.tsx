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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CampaignCatalogBulkOperation,
  CampaignCatalogBulkResult,
  CampaignCatalogEntry,
  CampaignCatalogFieldVisibility,
  CampaignCatalogPage,
  CampaignCatalogPrivacyPolicy,
  CampaignCatalogSort,
  CampaignExportRequest,
  CampaignExportRequestPage,
} from '@campfire/schema';
import { api, API, translateApiError } from '../../lib/api';
import { isImeComposing } from '../../lib/compositionSafeSubmit';
import { Btn, Card, Chip, ErrorNote, EmptyState, Skeleton, TextInput } from '../../components/ui';
import { GameIcon } from '../../components/GameIcon';
import { PageTitle } from '../../components/PageTitle';
import { RequireServerAdmin } from './RequireServerAdmin';
import {
  CATALOG_PAGE_SIZE,
  EMPTY_BULK_ARGS,
  EMPTY_FILTERS,
  availableOperations,
  buildBulkPayload,
  buildCatalogQuery,
  bulkArgsError,
  bulkPayloadFingerprint,
  createLatestOnlyGate,
  currentPage,
  isNoOpResult,
  outcomeVariant,
  pageCount,
  reconcileOperation,
  selectedEntriesFrom,
  storageLabel,
  type BulkArgs,
  type CatalogFilters,
} from './adminCatalogState';
import { UI_ICON_SIZE } from '../../lib/uiIcons';

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
}

/**
 * The server-wide disclosure default, as an operator SETS it rather than merely reads it.
 *
 * `PUT /admin/campaigns/privacy` shipped with no caller: the page fetched the policy and
 * printed it, so the name/description defaults the catalog advertises could not be
 * configured through the product at all. Both fields are always submitted together
 * because the server materialises the whole policy on any update — see
 * `updatePrivacyPolicy` — so showing two selects and sending both is what the stored
 * value actually reflects.
 */
function PrivacyPolicyCard({
  policy,
  onSaved,
}: {
  policy: CampaignCatalogPrivacyPolicy;
  onSaved: (next: CampaignCatalogPrivacyPolicy) => void;
}) {
  const { t } = useTranslation();
  const [names, setNames] = useState<CampaignCatalogFieldVisibility>(policy.names);
  const [descriptions, setDescriptions] = useState<CampaignCatalogFieldVisibility>(policy.descriptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow the server if it changes underneath us (a reload, or another operator).
  useEffect(() => {
    setNames(policy.names);
    setDescriptions(policy.descriptions);
  }, [policy.names, policy.descriptions]);

  const dirty = names !== policy.names || descriptions !== policy.descriptions;

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.put<CampaignCatalogPrivacyPolicy>(`${API}/admin/campaigns/privacy`, {
        names,
        descriptions,
      });
      onSaved(next);
      setSaved(true);
    } catch (err) {
      setError(translateApiError(err, t, { fallbackKey: 'admin.errors.savePrivacyPolicy' }));
    } finally {
      setBusy(false);
    }
  };

  const options = (
    <>
      <option value="visible">{t('admin.catalog.privacy.visible')}</option>
      <option value="redacted">{t('admin.catalog.privacy.redacted')}</option>
    </>
  );

  return (
    <Card className="space-y-3">
      <h2 className="text-sm font-bold text-white">{t('admin.catalog.privacy.heading')}</h2>
      <p className="text-xs text-secondary">{t('admin.catalog.privacy.hint')}</p>
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1 text-xs text-secondary">
          {t('admin.catalog.privacy.names')}
          <select
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
            value={names}
            onChange={(e) => setNames(e.target.value as CampaignCatalogFieldVisibility)}
          >
            {options}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-secondary">
          {t('admin.catalog.privacy.descriptions')}
          <select
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
            value={descriptions}
            onChange={(e) => setDescriptions(e.target.value as CampaignCatalogFieldVisibility)}
          >
            {options}
          </select>
        </label>
        <Btn disabled={busy || !dirty} onClick={() => void save()}>
          {t('admin.catalog.privacy.save')}
        </Btn>
      </div>
      <p className="text-xs text-secondary">
        {policy.source === 'default'
          ? t('admin.catalog.privacy.sourceDefault')
          : t('admin.catalog.privacy.sourceSettings')}
      </p>
      {/* A campaign can always tighten past this; it can never loosen. Saying so here
          stops an operator reading `visible` as "every name is disclosed". */}
      <p className="text-xs text-secondary">{t('admin.catalog.privacy.tightenOnly')}</p>
      {saved && !dirty && <p className="text-xs text-emerald-300">{t('admin.catalog.privacy.saved')}</p>}
      {error && <ErrorNote message={error} />}
    </Card>
  );
}

/** Rows fetched per read of the admin's cross-campaign export-request queue. */
const EXPORT_REQUEST_ADMIN_PAGE = 100;

const EXPORT_PROFILE_KEY: Record<string, string> = {
  backup: 'admin.catalog.args.profileBackup',
  handoff: 'admin.catalog.args.profileHandoff',
  publish: 'admin.catalog.args.profilePublish',
};

/**
 * Server-admin export-request queue (issue #1585).
 *
 * `GET /admin/campaigns/export-requests` shipped with #587 — paged, with a real `total`,
 * audited — and nothing in the web app ever called it. An operator could RAISE a request
 * (the bulk `request_export` operation above) but had no way to see what happened to it:
 * whether it is still pending, whether the DM approved or denied it, or read the decision
 * note the DM wrote back. That is the other half of the same workflow
 * `ExportRequestsCard` (CampaignSettingsPage.tsx) gives the DM — this is the requester's
 * half, and it was entirely missing.
 *
 * PATTERN REUSE, DELIBERATELY. This mirrors `ExportRequestsCard` rather than inventing a
 * second shape for the same data: load-on-mount (not polling — every read of this endpoint
 * writes an audit row, specifically BECAUSE it discloses requester justifications and DM
 * decision notes, so a poll would produce audit volume proportional to the poll rate; see
 * the endpoint's own doc comment), offset paging via a growing "show more" window rather
 * than a shrinking `limit`, and the same pending/decided split. The one addition is the
 * `campaignId` filter the admin endpoint supports and the DM one has no reason to.
 *
 * CAMPAIGN NAMES ARE DELIBERATELY NOT RESOLVED. `GET /admin/campaigns/:campaignId` would
 * do it, but that route is ALSO audited (twice: the server-admin trail and the campaign's
 * own) — resolving a name per unique campaign in the queue would multiply exactly the
 * audit volume this card exists to keep flat. Each row shows `Campaign #<id>` instead,
 * which doubles as the affordance for filtering the queue down to that campaign.
 *
 * PENDING COUNT IS SCOPED TO THE LOADED WINDOW. The admin endpoint orders newest-first by
 * id, not pending-first like the DM's per-campaign inbox — across every campaign there is
 * no single natural ordering that would put all outstanding asks on page one. The initial
 * load asks for a full page at the server's own max size so the common case (a queue that
 * fits in one page) reports an exact count, and the badge is phrased to say "in view"
 * rather than claim a global total the endpoint cannot cheaply provide.
 */
function ExportRequestsQueueCard() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<CampaignExportRequest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [campaignFilterDraft, setCampaignFilterDraft] = useState('');
  const [campaignFilter, setCampaignFilter] = useState<number | undefined>(undefined);
  const loadGate = useRef(createLatestOnlyGate());

  const load = useCallback(
    async (pages = 1) => {
      const isNewest = loadGate.current.start();
      setLoading(true);
      setError(null);
      try {
        const collected: CampaignExportRequest[] = [];
        let seenTotal = 0;
        let fetched = 0;
        for (let i = 0; i < pages; i += 1) {
          const qs = new URLSearchParams({
            limit: String(EXPORT_REQUEST_ADMIN_PAGE),
            offset: String(i * EXPORT_REQUEST_ADMIN_PAGE),
          });
          if (campaignFilter !== undefined) qs.set('campaignId', String(campaignFilter));
          const page = await api.get<CampaignExportRequestPage>(
            `${API}/admin/campaigns/export-requests?${qs.toString()}`,
          );
          if (!isNewest()) return;
          collected.push(...page.items);
          seenTotal = page.total;
          fetched += 1;
          if (!page.hasMore) break;
        }
        if (!isNewest()) return;
        setRequests(collected);
        setTotal(seenTotal);
        setPagesLoaded(Math.max(1, fetched));
      } catch (err) {
        if (!isNewest()) return;
        setError(translateApiError(err, t, { fallbackKey: 'admin.errors.loadExportRequests' }));
      } finally {
        if (isNewest()) setLoading(false);
      }
    },
    [campaignFilter, t],
  );

  // Load on mount, and again whenever the applied campaign filter changes — never on a
  // timer (see the class doc comment on why polling this endpoint is the wrong shape).
  useEffect(() => {
    void load();
  }, [load]);

  async function showMore() {
    setLoadingMore(true);
    try {
      await load(pagesLoaded + 1);
    } finally {
      setLoadingMore(false);
    }
  }

  function applyCampaignFilter(id: number | undefined) {
    setCampaignFilterDraft(id === undefined ? '' : String(id));
    setCampaignFilter(id);
  }

  const pending = (requests ?? []).filter((r) => r.status === 'pending');
  const decided = (requests ?? []).filter((r) => r.status !== 'pending');
  // True only while the loaded window already covers the entire queue — otherwise a
  // pending request could still be sitting further back than this card has fetched.
  const pendingCountIsComplete = requests !== null && requests.length >= total;

  if (loading && requests === null) {
    return (
      <Card>
        <Skeleton lines={4} />
      </Card>
    );
  }

  return (
    <Card className="space-y-3" data-testid="admin-export-requests">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-bold text-white">{t('admin.exportRequests.heading')}</h2>
        {pending.length > 0 && (
          <Chip variant="failed">
            {pendingCountIsComplete
              ? t('admin.exportRequests.pendingBadge', { count: pending.length })
              : t('admin.exportRequests.pendingBadgeAtLeast', { count: pending.length })}
          </Chip>
        )}
      </div>
      <p className="text-xs text-secondary">{t('admin.exportRequests.hint')}</p>

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col gap-1 text-xs text-secondary">
          {t('admin.exportRequests.filterLabel')}
          <TextInput
            inputMode="numeric"
            value={campaignFilterDraft}
            onChange={(e) => setCampaignFilterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const n = Number(campaignFilterDraft);
              applyCampaignFilter(Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);
            }}
            placeholder={t('admin.exportRequests.filterPlaceholder')}
          />
        </label>
        <Btn
          ghost
          onClick={() => {
            const n = Number(campaignFilterDraft);
            applyCampaignFilter(Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined);
          }}
        >
          {t('admin.exportRequests.filterApply')}
        </Btn>
        {campaignFilter !== undefined && (
          <Btn ghost onClick={() => applyCampaignFilter(undefined)}>
            {t('admin.exportRequests.filterClear')}
          </Btn>
        )}
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(pagesLoaded)} />}

      {requests !== null && requests.length === 0 && !error && (
        <p className="text-xs text-secondary">
          {campaignFilter !== undefined
            ? t('admin.exportRequests.emptyFiltered', { id: campaignFilter })
            : t('admin.exportRequests.empty')}
        </p>
      )}

      {pending.map((r) => (
        <div key={r.id} className="flex flex-col gap-1" style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 8 }}>
          <p className="text-xs text-secondary">
            <button
              type="button"
              className="underline underline-offset-2"
              style={{ color: 'var(--color-accent)' }}
              onClick={() => applyCampaignFilter(r.campaignId)}
            >
              {t('admin.exportRequests.campaignLink', { id: r.campaignId })}
            </button>{' '}
            {t('admin.exportRequests.requestedLine', {
              who: r.requestedBy,
              profile: r.profile && EXPORT_PROFILE_KEY[r.profile] ? t(EXPORT_PROFILE_KEY[r.profile]) : r.profile || t('admin.catalog.args.profileBackup'),
              date: r.createdAt.slice(0, 10),
            })}
          </p>
          {r.justification && (
            <p className="text-xs text-secondary">
              <span>{t('admin.exportRequests.justificationLabel')} </span>
              <span className="text-white">{r.justification}</span>
            </p>
          )}
        </div>
      ))}

      {decided.length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-divider)', paddingTop: 8 }}>
          <p className="text-xs text-secondary">{t('admin.exportRequests.decidedHeading')}</p>
          <ul className="space-y-1" style={{ margin: '4px 0 0', paddingInlineStart: 16 }}>
            {decided.map((r) => (
              <li key={r.id} className="text-xs text-secondary">
                <button
                  type="button"
                  className="underline underline-offset-2"
                  style={{ color: 'var(--color-accent)' }}
                  onClick={() => applyCampaignFilter(r.campaignId)}
                >
                  {t('admin.exportRequests.campaignLink', { id: r.campaignId })}
                </button>{' '}
                {r.createdAt.slice(0, 10)} — {r.requestedBy}:{' '}
                <Chip variant={r.status === 'approved' ? 'completed' : r.status === 'denied' ? 'failed' : 'neutral'}>
                  {t(`admin.exportRequests.status.${r.status}`)}
                </Chip>
                {r.decidedBy && (
                  <span> {t('admin.exportRequests.decidedBy', { who: r.decidedBy, date: (r.decidedAt ?? '').slice(0, 10) })}</span>
                )}
                {r.decisionNote && (
                  <div className="text-white">
                    {t('admin.exportRequests.decisionNoteLabel')} {r.decisionNote}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {requests !== null && requests.length < total && (
        <Btn ghost disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => void showMore()}>
          {t('admin.exportRequests.showMore', { shown: requests.length, total })}
        </Btn>
      )}
    </Card>
  );
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
  /**
   * The selected campaigns, BY VALUE rather than by id.
   *
   * This deliberately survives pagination, and holding the entries themselves is what
   * makes that safe. It used to be a `Set<number>` that persisted across pages while the
   * derived `selectedEntries` was `items.filter(...)` over the CURRENT page only — so
   * ticking twelve campaigns across three pages showed a count of four and dispatched
   * four. The other eight were silently dropped: no error, no skip reason, and their
   * boxes still ticked on the way back. The console did less than the operator asked and
   * reported success.
   *
   * Keeping the entry means a selection off-page still counts, still dispatches, and
   * still contributes to `availableOperations`. Those retained rows can be stale if the
   * campaign changed since it was fetched, but only the client-side courtesies read
   * them — the server re-decides eligibility per item and reports a reason per item, so
   * a stale row costs an accurate skip rather than a wrong write.
   */
  const [selected, setSelected] = useState<Map<number, CampaignCatalogEntry>>(new Map());
  const [operation, setOperation] = useState<CampaignCatalogBulkOperation>('archive');
  const [bulkArgs, setBulkArgs] = useState<BulkArgs>(EMPTY_BULK_ARGS);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<CampaignCatalogBulkResult | null>(null);
  // The payload fingerprint `preview` was produced from. Apply is gated on this still
  // matching what would be sent now — see `bulkPayloadFingerprint`.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // Only the newest in-flight load may commit — see `createLatestOnlyGate`. Without this,
  // a slow response for a superseded filter/sort/page repaints the table with rows that
  // do not match the visible controls, and those rows are selectable into a bulk
  // operation that reassigns ownership and rewrites privacy policy.
  const loadGate = useRef(createLatestOnlyGate());

  const load = useCallback(async () => {
    const isNewest = loadGate.current.start();
    setLoading(true);
    setError(null);
    try {
      const query = buildCatalogQuery(filters, { offset, limit: CATALOG_PAGE_SIZE, sort, order });
      const [rows, pol] = await Promise.all([
        api.get<CampaignCatalogPage>(`${API}/admin/campaigns?${query}`),
        api.get<CampaignCatalogPrivacyPolicy>(`${API}/admin/campaigns/privacy`),
      ]);
      // A newer load started while this was in flight: ITS result is the one the
      // operator's controls describe, so this one is discarded rather than painted.
      if (!isNewest()) return;
      setPage(rows);
      setPolicy(pol);
    } catch (err) {
      // A superseded load's failure is equally irrelevant — surfacing it would replace a
      // good newer page with an error about a query nobody is looking at any more.
      if (!isNewest()) return;
      setError(translateApiError(err, t, { fallbackKey: 'admin.errors.loadCampaigns' }));
    } finally {
      // Leave the spinner up if a newer load is still running; that one owns the flag.
      if (isNewest()) setLoading(false);
    }
  }, [filters, offset, sort, order, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => page?.items ?? [], [page]);
  // Every selected campaign, including ones on pages the operator has navigated away
  // from. Sorted by id so the payload and its fingerprint do not depend on click order.
  const selectedEntries = useMemo(() => selectedEntriesFrom(selected), [selected]);
  const operations = useMemo(() => availableOperations(selectedEntries), [selectedEntries]);

  // Keep the chooser honest. When the selection narrows `operations`, a `<select>` whose
  // value is no longer among its options renders the first one while state keeps the old
  // value — the operator would read one verb and dispatch another.
  useEffect(() => {
    setOperation((prev) => {
      const next = reconcileOperation(prev, operations);
      return next === prev ? prev : next;
    });
  }, [operations]);

  // Everything the next request would carry, as one comparable string. Apply is only
  // offered while this still equals the fingerprint the preview was produced from, so
  // editing ANY field after a dry run — owner, quota, policy, module, profile, reason,
  // selection — retires the preview instead of silently re-aiming it.
  const currentBulkKey = useMemo(
    () => bulkPayloadFingerprint(operation, selectedEntries.map((c) => c.id), reason, bulkArgs),
    [operation, selectedEntries, reason, bulkArgs],
  );
  // SCOPED TO AN ACTUAL PREVIEW. After a real run, `preview` is deliberately kept so the
  // per-item results stay on screen, but `previewKey` is cleared and the selection is
  // emptied — which made the fingerprint comparison report a just-completed apply as
  // "out of date" and tell the operator to re-run a dry run for work that had already
  // succeeded. The fingerprint answers "does this preview still describe what Apply
  // would do", a question that only means anything while the result IS a preview.
  const previewStale = preview !== null && preview.dryRun === true && previewKey !== currentBulkKey;

  // What (if anything) stops this run, as a translation key. The server re-validates
  // everything; this only keeps the page from dispatching a request it can already see
  // will 400, and lets the operator read the reason instead of guessing at a dead button.
  const blocked = useMemo(() => {
    const argsError = bulkArgsError(operation, bulkArgs);
    if (argsError) return argsError;
    // `request_export` asks a DM to hand over every secret in their campaign, so the
    // server demands a justification of at least 10 characters. Mirror that here.
    if (operation === 'request_export' && reason.trim().length < 10) {
      return 'admin.catalog.args.justificationRequired';
    }
    return null;
  }, [operation, bulkArgs, reason]);

  const toggle = (entry: CampaignCatalogEntry) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.set(entry.id, entry);
      return next;
    });
    setPreview(null);
  };

  const applyFilters = (next: Partial<CatalogFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setOffset(0);
    // Filters redefine which campaigns are even under consideration, so a selection made
    // against the previous predicate is not meaningful against this one. Paging does NOT
    // clear — see the `selected` declaration.
    setSelected(new Map());
    setPreview(null);
  };

  const runBulk = useCallback(
    async (dryRun: boolean) => {
      if (selectedEntries.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const result = await api.post<CampaignCatalogBulkResult>(
          `${API}/admin/campaigns/bulk`,
          buildBulkPayload(
            operation,
            selectedEntries.map((c) => c.id),
            dryRun,
            reason,
            bulkArgs,
            // On a real run, carry the previewed per-campaign versions so the server
            // applies the plan that was shown rather than replanning from state that has
            // since moved. A campaign that changed comes back as a skip with a reason.
            dryRun ? null : preview,
          ),
        );
        setPreview(result);
        // Stamp the preview with exactly what produced it, so a later edit to any field
        // makes the mismatch visible rather than leaving Apply pointed somewhere new.
        setPreviewKey(currentBulkKey);
        if (!dryRun) {
          setSelected(new Map());
          setPreviewKey(null);
          await load();
        }
      } catch (err) {
        setError(translateApiError(err, t, { fallbackKey: 'admin.errors.bulkCampaigns' }));
      } finally {
        setBusy(false);
      }
    },
    [operation, reason, bulkArgs, selectedEntries, currentBulkKey, preview, load, t],
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
      <PageTitle className="flex items-center gap-2 text-xl text-white">
        <GameIcon slug="scroll-quill" size={UI_ICON_SIZE.md} aria-hidden /> {t('admin.catalog.title')}
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
                if (e.key === 'Enter' && !isImeComposing(e)) applyFilters({ q: draftQuery });
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

      {/* Refetch the rows, not just the policy. Tightening `names` to `redacted` is a
          deliberate act to STOP showing those names; leaving the already-loaded page
          rendering them until some unrelated reload makes the product's response to that
          act "keep showing them". Refetching rather than redacting client-side keeps the
          redaction rule in exactly one place — the server — instead of adding a second
          implementation here that has to agree with it. */}
      {policy && (
        <PrivacyPolicyCard
          policy={policy}
          onSaved={(next) => {
            setPolicy(next);
            void load();
          }}
        />
      )}

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
                        onChange={() => toggle(entry)}
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
                      {/* THE DESCRIPTION HAS TO BE VISIBLE WHEN THE POLICY SAYS IT IS.
                          The server returns it under a `visible` policy and lets `?q=`
                          match it, but nothing rendered it — so an operator could not
                          read a field they had explicitly configured as visible, and a
                          description-only search hit looked like a row matching on
                          nothing. Shown as a secondary line rather than a column because
                          it runs to 10k characters; the full text is in the title.
                          `descriptionRedacted` rows carry '' by construction (see the
                          schema), so a withheld description renders nothing at all —
                          there is no placeholder to leak a length or a shape. */}
                      {entry.description !== '' && (
                        <div
                          className="text-xs text-secondary truncate max-w-xs"
                          title={entry.description}
                          data-testid={`catalog-description-${entry.id}`}
                        >
                          {entry.description}
                        </div>
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
          {operation === 'reassign_owner' && (
            <label className="flex flex-col gap-1 text-xs text-secondary">
              {t('admin.catalog.args.toUserId')}
              <TextInput
                inputMode="numeric"
                value={bulkArgs.toUserId}
                onChange={(e) => setBulkArgs((p) => ({ ...p, toUserId: e.target.value }))}
              />
            </label>
          )}

          {operation === 'set_quota' && (
            <label className="flex flex-col gap-1 text-xs text-secondary">
              {t('admin.catalog.args.storageQuotaBytes')}
              <TextInput
                inputMode="numeric"
                placeholder={t('admin.catalog.args.quotaClearHint')}
                value={bulkArgs.storageQuotaBytes}
                onChange={(e) => setBulkArgs((p) => ({ ...p, storageQuotaBytes: e.target.value }))}
              />
            </label>
          )}

          {operation === 'set_policy' && (
            <>
              <label className="flex items-center gap-2 text-xs text-secondary">
                <input
                  type="checkbox"
                  checked={bulkArgs.closePublicInvites}
                  onChange={(e) => setBulkArgs((p) => ({ ...p, closePublicInvites: e.target.checked }))}
                />
                {t('admin.catalog.args.closePublicInvites')}
              </label>
              <label className="flex flex-col gap-1 text-xs text-secondary">
                {t('admin.catalog.args.aiExternalContentPolicy')}
                <select
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                  value={bulkArgs.aiExternalContentPolicy}
                  onChange={(e) =>
                    setBulkArgs((p) => ({
                      ...p,
                      aiExternalContentPolicy: e.target.value as BulkArgs['aiExternalContentPolicy'],
                    }))
                  }
                >
                  <option value="">{t('admin.catalog.args.aiPolicyUnchanged')}</option>
                  <option value="disabled">{t('admin.catalog.args.aiPolicyDisabled')}</option>
                  <option value="member_consent">{t('admin.catalog.args.aiPolicyMemberConsent')}</option>
                </select>
              </label>
            </>
          )}

          {operation === 'update_module' && (
            <label className="flex flex-col gap-1 text-xs text-secondary">
              {t('admin.catalog.args.ruleSystem')}
              <TextInput
                value={bulkArgs.ruleSystem}
                onChange={(e) => setBulkArgs((p) => ({ ...p, ruleSystem: e.target.value }))}
              />
            </label>
          )}

          {operation === 'request_export' && (
            <label className="flex flex-col gap-1 text-xs text-secondary">
              {t('admin.catalog.args.exportProfile')}
              <select
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-white"
                value={bulkArgs.exportProfile}
                onChange={(e) =>
                  setBulkArgs((p) => ({ ...p, exportProfile: e.target.value as BulkArgs['exportProfile'] }))
                }
              >
                <option value="backup">{t('admin.catalog.args.profileBackup')}</option>
                <option value="handoff">{t('admin.catalog.args.profileHandoff')}</option>
                <option value="publish">{t('admin.catalog.args.profilePublish')}</option>
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1 text-xs text-secondary flex-1 min-w-[200px]">
            {operation === 'request_export'
              ? t('admin.catalog.args.justification')
              : t('admin.catalog.bulkReason')}
            <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Btn disabled={busy || selectedEntries.length === 0 || blocked !== null} onClick={() => void runBulk(true)}>
            {t('admin.catalog.dryRun')}
          </Btn>
          <Btn
            disabled={busy || preview === null || preview.dryRun === false || blocked !== null || previewStale}
            onClick={() => void runBulk(false)}
          >
            {t('admin.catalog.apply')}
          </Btn>
        </div>

        {/* Say WHY the buttons are disabled. A dead button with no explanation is the
            thing this whole card is trying to stop the operator running into. */}
        {blocked !== null && selectedEntries.length > 0 && (
          <p className="text-xs text-amber-300">{t(blocked)}</p>
        )}
        {/* The preview no longer describes what Apply would do. Say so instead of
            leaving a disabled button and a result panel that look like agreement. */}
        {previewStale && blocked === null && (
          <p className="text-xs text-amber-300">{t('admin.catalog.previewStale')}</p>
        )}
        {operation === 'set_policy' && (
          <p className="text-xs text-secondary">{t('admin.catalog.args.invitesCloseOnlyHint')}</p>
        )}

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
      <div className="max-w-6xl mx-auto px-4 mt-5">
        {/* #1585 — surfaced above the catalog itself: an operator landing on this page
            should see whether anything is waiting on a DM's decision without having to
            scroll past the filters and the campaign table first. */}
        <ExportRequestsQueueCard />
      </div>
      <AdminCatalog />
    </RequireServerAdmin>
  );
}
