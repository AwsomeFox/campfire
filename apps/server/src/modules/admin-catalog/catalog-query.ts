/**
 * Query-string parsing for the admin catalog (issue #587).
 *
 * Kept out of the controller and the service so it is unit-testable without a Nest
 * app: every one of these values becomes a SQL predicate, so "what does `?overQuota=`
 * mean when it says `banana`?" is a question with a real answer worth pinning.
 *
 * Follows the repo's hand-parsed query convention (parseModerationLimit, boolQuery in
 * export.controller.ts) rather than a zod query DTO — Nest's global ZodValidationPipe
 * only covers bodies and typed params here.
 */
import { BadRequestException } from '@nestjs/common';
import { CampaignCatalogSort } from '@campfire/schema';
import type { CatalogQuery } from './admin-catalog.service';

/** Only `1|true|yes` are true, and only `0|false|no` are false; anything else 400s. */
export function boolQuery(raw: string | undefined, field: string): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  throw new BadRequestException(`\`${field}\` must be a boolean`);
}

export function intQuery(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new BadRequestException(`\`${field}\` must be a number`);
  return Math.floor(n);
}

function nonNegativeIntQuery(raw: string | undefined, field: string): number | undefined {
  const n = intQuery(raw, field);
  if (n !== undefined && n < 0) throw new BadRequestException(`\`${field}\` must be non-negative`);
  return n;
}

const STATUSES = ['active', 'paused', 'completed'] as const;

/** Raw `?…` values as Nest hands them over. */
export type RawCatalogQuery = Partial<
  Record<
    | 'limit'
    | 'offset'
    | 'sort'
    | 'order'
    | 'q'
    | 'status'
    | 'ruleSystem'
    | 'packageVersion'
    | 'moduleInstalled'
    | 'primaryDmUserId'
    | 'nextSessionAfter'
    | 'nextSessionBefore'
    | 'activityAfter'
    | 'activityBefore'
    | 'minStorageBytes'
    | 'overQuota'
    | 'trashed',
    string
  >
>;

export function parseCatalogQuery(raw: RawCatalogQuery): CatalogQuery {
  const status = raw.status?.trim();
  if (status !== undefined && status !== '' && !STATUSES.includes(status as 'active')) {
    throw new BadRequestException(`\`status\` must be one of ${STATUSES.join(', ')}`);
  }

  let sort: CatalogQuery['sort'];
  if (raw.sort !== undefined && raw.sort !== '') {
    const parsed = CampaignCatalogSort.safeParse(raw.sort);
    if (!parsed.success) {
      throw new BadRequestException(`\`sort\` must be one of ${CampaignCatalogSort.options.join(', ')}`);
    }
    sort = parsed.data;
  }

  let order: 'asc' | 'desc' | undefined;
  if (raw.order !== undefined && raw.order !== '') {
    const v = raw.order.trim().toLowerCase();
    if (v !== 'asc' && v !== 'desc') throw new BadRequestException('`order` must be asc or desc');
    order = v;
  }

  const primaryDmUserId = nonNegativeIntQuery(raw.primaryDmUserId, 'primaryDmUserId');
  if (primaryDmUserId !== undefined && primaryDmUserId < 1) {
    throw new BadRequestException('`primaryDmUserId` must be a positive integer');
  }

  return {
    limit: nonNegativeIntQuery(raw.limit, 'limit'),
    offset: nonNegativeIntQuery(raw.offset, 'offset'),
    sort,
    order,
    q: raw.q?.trim() || undefined,
    status: status ? (status as 'active' | 'paused' | 'completed') : undefined,
    // Distinguishes "not filtering" from "filtering for the empty slug" — a campaign
    // with no rule system set is a real thing an operator wants to find, so
    // `?ruleSystem=` (present but empty) is a meaningful filter, not a no-op.
    ruleSystem: raw.ruleSystem === undefined ? undefined : raw.ruleSystem,
    packageVersion: raw.packageVersion === undefined ? undefined : raw.packageVersion,
    moduleInstalled: boolQuery(raw.moduleInstalled, 'moduleInstalled'),
    primaryDmUserId,
    nextSessionAfter: raw.nextSessionAfter || undefined,
    nextSessionBefore: raw.nextSessionBefore || undefined,
    activityAfter: raw.activityAfter || undefined,
    activityBefore: raw.activityBefore || undefined,
    minStorageBytes: nonNegativeIntQuery(raw.minStorageBytes, 'minStorageBytes'),
    overQuota: boolQuery(raw.overQuota, 'overQuota'),
    trashed: boolQuery(raw.trashed, 'trashed'),
  };
}
