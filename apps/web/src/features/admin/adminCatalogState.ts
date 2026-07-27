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
  AiExternalContentPolicy,
  CampaignCatalogBulkOperation,
  CampaignCatalogBulkResult,
  CampaignCatalogEntry,
  CampaignCatalogSort,
  ExportProfile,
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
 * Empty values are OMITTED rather than sent blank. For the filters this module actually
 * sends that is merely tidy — `parseCatalogQuery` already maps an empty `status`,
 * `moduleInstalled`, `overQuota`, `trashed` or `q` to "not filtering".
 *
 * It becomes load-bearing the moment anyone adds `ruleSystem` or `packageVersion` to
 * `CatalogFilters`: those are the two parameters where the server deliberately
 * distinguishes ABSENT from PRESENT-BUT-EMPTY, because "campaigns with no rule system
 * set" is a real condition an operator wants to find. Serialising either of those
 * unconditionally would silently apply a filter nobody chose, so keep the omit-empty
 * habit here and that addition stays safe.
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
 * Keep the chosen operation valid as the selection changes.
 *
 * `availableOperations` narrows with the selection, but the chooser's state does not
 * follow it on its own. When the current operation drops out of the list, a `<select>`
 * with no matching `<option>` renders the FIRST option while still holding the stale
 * value — so the operator reads "archive" and dispatches "pause". Reconciling on every
 * change is what stops the control from lying about what the button will do.
 */
export function reconcileOperation(
  current: CampaignCatalogBulkOperation,
  available: CampaignCatalogBulkOperation[],
): CampaignCatalogBulkOperation {
  if (available.length === 0) return current;
  return available.includes(current) ? current : available[0];
}

/**
 * The operation-specific arguments, as the form holds them.
 *
 * Everything is a string because these come straight from inputs; `buildBulkPayload`
 * is the single place that converts and drops the fields the operation does not use.
 */
export type BulkArgs = {
  /** reassign_owner: the user id that becomes dm + primary owner. */
  toUserId: string;
  /** set_quota: bytes, or '' to CLEAR the quota (sent as null). */
  storageQuotaBytes: string;
  /** set_policy: close public invite links. Only ever closes — see below. */
  closePublicInvites: boolean;
  /** set_policy: '' leaves the AI content policy untouched. */
  aiExternalContentPolicy: '' | AiExternalContentPolicy;
  /** update_module: rule-pack slug. */
  ruleSystem: string;
  /** request_export: which profile the DM is asked to produce. */
  exportProfile: ExportProfile;
};

export const EMPTY_BULK_ARGS: BulkArgs = {
  toUserId: '',
  storageQuotaBytes: '',
  closePublicInvites: false,
  aiExternalContentPolicy: '',
  ruleSystem: '',
  exportProfile: 'backup',
};

/**
 * Why the current arguments cannot be submitted yet, as a translation key, or null.
 *
 * Mirrors `validateBulkArgs` on the server. The server remains the decider — this only
 * stops the page dispatching a request it can already see will 400, which is the
 * difference between a disabled button with a reason and a red error after the click.
 */
export function bulkArgsError(operation: CampaignCatalogBulkOperation, args: BulkArgs): string | null {
  switch (operation) {
    case 'reassign_owner':
      return /^\d+$/.test(args.toUserId.trim()) && Number(args.toUserId.trim()) > 0
        ? null
        : 'admin.catalog.args.toUserIdRequired';
    case 'set_quota': {
      const raw = args.storageQuotaBytes.trim();
      if (raw === '') return null; // '' is a deliberate "clear the quota", sent as null
      return /^\d+$/.test(raw) ? null : 'admin.catalog.args.quotaInvalid';
    }
    case 'set_policy':
      // The server requires at least one of the two policy fields.
      return args.closePublicInvites || args.aiExternalContentPolicy !== ''
        ? null
        : 'admin.catalog.args.policyRequired';
    case 'update_module':
      return args.ruleSystem.trim() === '' ? 'admin.catalog.args.ruleSystemRequired' : null;
    case 'request_export':
      return null; // exportProfile always holds a valid enum value; `reason` is checked below
    default:
      return null;
  }
}

/**
 * The exact request body for a bulk run.
 *
 * Built here rather than inline in the page so the "which operation carries which
 * argument" mapping is unit-testable against the server's DTO — four of the five
 * argument-taking operations used to send nothing but `operation`/`campaignIds`/
 * `dryRun`/`reason`, so every one of them 400'd even as a dry run.
 */
export function buildBulkPayload(
  operation: CampaignCatalogBulkOperation,
  campaignIds: number[],
  dryRun: boolean,
  reason: string,
  args: BulkArgs,
): Record<string, unknown> {
  const body: Record<string, unknown> = { operation, campaignIds, dryRun, reason };
  switch (operation) {
    case 'reassign_owner':
      body.toUserId = Number(args.toUserId.trim());
      break;
    case 'set_quota': {
      const raw = args.storageQuotaBytes.trim();
      // '' means CLEAR, which the server spells `null` — not "argument omitted".
      body.storageQuotaBytes = raw === '' ? null : Number(raw);
      break;
    }
    case 'set_policy':
      // Only ever `false`. The catalog can close public invites but not open them:
      // enabling is gated on the campaign being active and untrashed, and arming the
      // flag from here would revive every retained link on the next `activate`.
      if (args.closePublicInvites) body.publicInvitesEnabled = false;
      if (args.aiExternalContentPolicy !== '') body.aiExternalContentPolicy = args.aiExternalContentPolicy;
      break;
    case 'update_module':
      body.ruleSystem = args.ruleSystem.trim();
      break;
    case 'request_export':
      body.exportProfile = args.exportProfile;
      break;
    default:
      break;
  }
  return body;
}

/**
 * A stable fingerprint of everything a bulk run would send, minus `dryRun`.
 *
 * THE DRY RUN IS ONLY A SAFETY PROPERTY IF APPLY RUNS THE THING THAT WAS PREVIEWED.
 * "A preview exists" is not the same claim as "the preview describes what Apply will
 * do", and the gap between them is where an operator previews a reassignment to Alice,
 * edits the owner to Bob, and Apply proceeds against Bob having shown them Alice.
 *
 * Comparing fingerprints rather than clearing the preview on each individual edit is
 * deliberate: a clear-call has to be remembered for every field that can vary, and this
 * page has already demonstrated twice that it will not be. A fingerprint covers the
 * fields that exist today, the ones someone adds tomorrow, and `reason` — which the
 * original invalidation also missed — because it is derived from the payload builder
 * itself rather than from a list maintained by hand.
 *
 * `dryRun` is excluded because it is the one field that legitimately differs between the
 * preview and the apply.
 */
export function bulkPayloadFingerprint(
  operation: CampaignCatalogBulkOperation,
  campaignIds: number[],
  reason: string,
  args: BulkArgs,
): string {
  // Ids sorted so a different selection ORDER is not mistaken for a different batch.
  const sortedIds = [...campaignIds].sort((a, b) => a - b);
  const body = buildBulkPayload(operation, sortedIds, true, reason, args);
  delete body.dryRun;
  // Key order fixed, so two equal payloads always produce the same string.
  return JSON.stringify(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
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
