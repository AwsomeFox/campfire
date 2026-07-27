/**
 * Issue #587 — pure presentation logic for the server-admin campaign catalog.
 *
 * Extracted from the page component so it can be exercised without a browser (the
 * repo's `*.unit.spec.ts` convention) and so the page file stays about layout. Nothing
 * here is a control: the server re-decides every filter, every permission and every
 * bulk outcome. These are the courtesies that make the console usable — the difference
 * between an operator working a queue confidently and one clicking buttons that 400.
 */
import type {
  CampaignCatalogBulkOperation,
  CampaignCatalogBulkResult,
  CampaignCatalogEntry,
  CampaignCatalogSort,
} from '@campfire/schema';
import type { ChipVariant } from '../../components/chipVariants';

export const CATALOG_PAGE_SIZE = 25;

/** Filters the page can express. Mirrors the server's query parameters exactly. */
export type CatalogFilters = {
  q: string;
  status: '' | 'active' | 'paused' | 'completed';
  moduleInstalled: '' | 'true' | 'false';
  overQuota: boolean;
  trashed: boolean;
};

export const EMPTY_FILTERS: CatalogFilters = {
  q: '',
  status: '',
  moduleInstalled: '',
  overQuota: false,
  trashed: false,
};

/**
 * Build the catalog query string.
 *
 * Empty values are OMITTED rather than sent blank, and that distinction is load-bearing
 * on one parameter: the server treats a PRESENT-but-empty `ruleSystem` as "campaigns
 * with no rule system", so sending every filter unconditionally would silently apply a
 * filter the operator never chose.
 */
export function buildCatalogQuery(
  filters: CatalogFilters,
  page: { offset: number; limit: number; sort: CampaignCatalogSort; order: 'asc' | 'desc' },
): string {
  const params = new URLSearchParams();
  params.set('limit', String(page.limit));
  params.set('offset', String(page.offset));
  params.set('sort', page.sort);
  params.set('order', page.order);
  if (filters.q.trim() !== '') params.set('q', filters.q.trim());
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.moduleInstalled !== '') params.set('moduleInstalled', filters.moduleInstalled);
  if (filters.overQuota) params.set('overQuota', 'true');
  if (filters.trashed) params.set('trashed', 'true');
  return params.toString();
}

/** Human-readable byte size. Operators scan these columns; raw byte counts do not scan. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** Storage cell label, including the quota when one is set. */
export function storageLabel(entry: CampaignCatalogEntry): string {
  const used = formatBytes(entry.storageBytes);
  return entry.storageQuotaBytes === null ? used : `${used} / ${formatBytes(entry.storageQuotaBytes)}`;
}

/**
 * Which bulk operations the current selection can meaningfully take.
 *
 * Purely a courtesy — the server skips ineligible items with a reason regardless. The
 * point is to stop an operator selecting fifty campaigns and discovering afterwards
 * that the verb was never applicable to any of them.
 */
export function availableOperations(selected: CampaignCatalogEntry[]): CampaignCatalogBulkOperation[] {
  if (selected.length === 0) return [];
  const ops: CampaignCatalogBulkOperation[] = [];
  if (selected.some((c) => c.status !== 'completed')) ops.push('archive');
  if (selected.some((c) => c.status !== 'paused')) ops.push('pause');
  if (selected.some((c) => c.status !== 'active')) ops.push('activate');
  ops.push('reassign_owner', 'set_quota', 'set_policy', 'update_module', 'request_export');
  return ops;
}

/**
 * True when a bulk result changed nothing and the operator should be told why rather
 * than shown an empty success. A run where everything skipped is a real outcome, not a
 * failure, but presenting it as "done" is how an operator concludes an archive worked
 * when it did not.
 */
export function isNoOpResult(result: CampaignCatalogBulkResult): boolean {
  return result.applied === 0 && result.wouldApply === 0;
}

/** Chip variant for a per-item bulk outcome, from the shared chip palette. */
export function outcomeVariant(outcome: string): ChipVariant {
  switch (outcome) {
    case 'applied':
      return 'completed';
    // A dry-run row is a proposal in the literal sense — something that has not
    // happened yet and is waiting on a human to confirm it. Reusing the proposal chip
    // keeps that reading consistent with the rest of the app.
    case 'would_apply':
      return 'proposal';
    case 'skipped':
      return 'neutral';
    case 'failed':
      return 'failed';
    default:
      return 'neutral';
  }
}

/**
 * Whether a row's displayed name is a privacy placeholder rather than the real name.
 * The page badges these so an operator never mistakes `Campaign #42` for a table
 * someone actually named that.
 */
export function isPlaceholderName(entry: CampaignCatalogEntry): boolean {
  return entry.nameRedacted;
}

/** Page count for the offset pager, floor 1 so an empty catalog still reads "1 of 1". */
export function pageCount(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, limit)));
}

export function currentPage(offset: number, limit: number): number {
  return Math.floor(offset / Math.max(1, limit)) + 1;
}
