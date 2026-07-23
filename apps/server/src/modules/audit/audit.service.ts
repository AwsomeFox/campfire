import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm';
import type { AuditActorRole } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { auditLog } from '../../db/schema';
import { nowIso } from '../../common/time';

/**
 * #74: how long audit rows are retained before the background sweep prunes them.
 * Overridable via AUDIT_RETENTION_DAYS (0 or negative disables pruning entirely —
 * e.g. for operators who ship the log off-box and want to keep everything).
 * Default 365 days: long enough to answer "who changed this months ago", short
 * enough that a combat-heavy table doesn't grow the DB without bound.
 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

/** How often the retention sweep runs. Daily is plenty — retention is coarse (days). */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Internal page size when walking the full retained audit trail for campaign export
 * (#731). This is NOT a cap on how many rows are exported — we page until every row
 * in the snapshot is collected.
 */
export const EXPORT_AUDIT_PAGE_SIZE = 500;

/** #731: rows omitted from export vs snapshot — unit-tested for pruning/post-append semantics. */
export function computeCampaignAuditExportTruncated(
  total: number,
  exported: number,
  retainedNow: number,
  retainedInSnapshotNow: number,
): number {
  const missingFromSnapshot = Math.max(0, total - exported);
  const appendedAfterSnapshot = Math.max(0, retainedNow - retainedInSnapshotNow);
  return missingFromSnapshot + appendedAfterSnapshot;
}

/** Metadata bundled with campaign exports so a partial audit slice never looks complete. */
export type CampaignAuditExportMeta = {
  /** Rows retained for this campaign with id <= snapshotMaxId at capture time. */
  total: number;
  /** Rows actually present in the export's `audit` array. */
  exported: number;
  /**
   * Rows omitted from this export relative to what the snapshot promised:
   * `(total - exported)` — rows at or below `cutoff.snapshotMaxId` that were not
   * collected (e.g. retention pruning during the walk), plus any rows appended after
   * the snapshot ceiling (`id > snapshotMaxId`, concurrent writes during export).
   */
  truncated: number;
  cutoff: {
    /** Monotonic autoincrement ceiling for this snapshot — rows with id > this are excluded. */
    snapshotMaxId: number;
    /** ISO timestamp when the snapshot ceiling was recorded. */
    capturedAt: string;
    /** createdAt of the oldest exported row (the trailing edge of included history). */
    oldestExportedCreatedAt: string | null;
  };
};

function resolveRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_AUDIT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_AUDIT_RETENTION_DAYS;
}

@Injectable()
export class AuditService implements OnApplicationBootstrap {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

  /**
   * Kick off retention. Mirrors AuthService's session sweep: prune once at boot
   * (awaited so a test's immediate `.close()` can't race an in-flight delete),
   * then re-sweep daily on an `.unref()`d timer so it never keeps Node alive.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.pruneExpired();
    const timer = setInterval(() => {
      void this.pruneExpired();
    }, PRUNE_INTERVAL_MS);
    timer.unref();
  }

  async log(params: {
    actor: string;
    actorRole: AuditActorRole;
    action: string;
    entityType?: string | null;
    entityId?: number | null;
    campaignId?: number | null;
    detail?: string;
  }): Promise<void> {
    await this.db.insert(auditLog).values({
      campaignId: params.campaignId ?? null,
      actor: params.actor,
      actorRole: params.actorRole,
      action: params.action,
      entityType: params.entityType ?? null,
      entityId: params.entityId ?? null,
      detail: params.detail ?? '',
      createdAt: nowIso(),
    });
  }

  /**
   * #161: a real delta channel for "what changed since last session". Beyond the
   * newest-first `limit`/`offset` window, an optional `filters` narrows the result:
   *   - `sinceId`  — only rows with id > sinceId (a monotonic autoincrement cursor:
   *                  read once, keep max(id), pass it back next time to fetch only
   *                  what's new — no client-side re-filtering of the whole log).
   *   - `sinceTs`  — only rows created strictly after this ISO timestamp (a wall-clock
   *                  cursor, e.g. a player's last-visit time; ISO-8601 sorts lexically).
   *   - `action`   — exact action match (e.g. 'npc.update').
   *   - `entityType` — exact entityType match (e.g. 'quest').
   * Still ordered newest-first so the freshest change is row 0; the caller takes the
   * first row's id as the next cursor. All filters compose (AND).
   */
  /** Count of retained audit rows for a campaign (all ids, or only id <= maxId when capped). */
  async countForCampaign(campaignId: number, maxId?: number): Promise<number> {
    const conditions = [eq(auditLog.campaignId, campaignId)];
    if (maxId != null) conditions.push(lte(auditLog.id, maxId));
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(and(...conditions));
    return Number(row?.n ?? 0);
  }

  /**
   * #731: export the full retained audit trail for a campaign from a stable snapshot.
   * Records the max(id) ceiling first, then keyset-pages every row with id <= that
   * ceiling (newest-first, same order as GET /audit). Rows inserted after the ceiling
   * are excluded from `entries` and counted in `meta.truncated` (with any snapshot
   * rows missed because of retention pruning during the walk).
   */
  async listForCampaignExport(campaignId: number): Promise<{
    entries: Awaited<ReturnType<AuditService['listForCampaign']>>;
    meta: CampaignAuditExportMeta;
  }> {
    const capturedAt = nowIso();
    const [maxRow] = await this.db
      .select({ maxId: sql<number>`coalesce(max(${auditLog.id}), 0)` })
      .from(auditLog)
      .where(eq(auditLog.campaignId, campaignId));
    const snapshotMaxId = Number(maxRow?.maxId ?? 0);
    const total = snapshotMaxId === 0 ? 0 : await this.countForCampaign(campaignId, snapshotMaxId);

    type Row = Awaited<ReturnType<AuditService['listForCampaign']>>[number];
    const entries: Row[] = [];
    if (snapshotMaxId > 0) {
      let cursorBelow: number | undefined;
      while (true) {
        const pageConditions = [eq(auditLog.campaignId, campaignId), lte(auditLog.id, snapshotMaxId)];
        if (cursorBelow != null) pageConditions.push(lt(auditLog.id, cursorBelow));
        const page = await this.db
          .select()
          .from(auditLog)
          .where(and(...pageConditions))
          .orderBy(desc(auditLog.id))
          .limit(EXPORT_AUDIT_PAGE_SIZE);
        if (!page.length) break;
        entries.push(...page);
        if (page.length < EXPORT_AUDIT_PAGE_SIZE) break;
        cursorBelow = page[page.length - 1]!.id;
      }
    }

    const exported = entries.length;
    const retainedNow = await this.countForCampaign(campaignId);
    const retainedInSnapshotNow = await this.countForCampaign(campaignId, snapshotMaxId);
    const truncated = computeCampaignAuditExportTruncated(total, exported, retainedNow, retainedInSnapshotNow);

    const oldest = entries.length ? entries[entries.length - 1]! : null;
    return {
      entries,
      meta: {
        total,
        exported,
        truncated,
        cutoff: {
          snapshotMaxId,
          capturedAt,
          oldestExportedCreatedAt: oldest?.createdAt ?? null,
        },
      },
    };
  }

  async listForCampaign(
    campaignId: number,
    limit = 100,
    offset = 0,
    filters: { sinceId?: number; sinceTs?: string; action?: string; entityType?: string } = {},
  ) {
    const conditions = [eq(auditLog.campaignId, campaignId)];
    if (filters.sinceId != null) conditions.push(gt(auditLog.id, filters.sinceId));
    if (filters.sinceTs != null && filters.sinceTs !== '') conditions.push(gt(auditLog.createdAt, filters.sinceTs));
    if (filters.action != null && filters.action !== '') conditions.push(eq(auditLog.action, filters.action));
    if (filters.entityType != null && filters.entityType !== '') conditions.push(eq(auditLog.entityType, filters.entityType));
    return this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .offset(offset);
  }

  /**
   * #23: the server-wide admin trail — every row NOT tied to a campaign
   * (campaign_id IS NULL): user create/disable/delete, settings changes,
   * rule-pack installs, admin token mints. Server-admin only (see controller).
   */
  async listServerAdmin(limit = 100, offset = 0) {
    return this.db
      .select()
      .from(auditLog)
      .where(isNull(auditLog.campaignId))
      .orderBy(desc(auditLog.id))
      .limit(limit)
      .offset(offset);
  }

  /**
   * #74: delete audit rows older than the retention window. Returns the number
   * of rows removed. A retentionDays <= 0 is a no-op (retention disabled).
   */
  async pruneExpired(retentionDays = resolveRetentionDays()): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db.delete(auditLog).where(lt(auditLog.createdAt, cutoff));
    // better-sqlite3 driver exposes rows-affected as `changes`.
    return (result as unknown as { changes?: number }).changes ?? 0;
  }
}
