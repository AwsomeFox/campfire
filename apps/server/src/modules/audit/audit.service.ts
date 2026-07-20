import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { desc, eq, isNull, lt } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
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
    actorRole: Role;
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

  async listForCampaign(campaignId: number, limit = 100) {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.campaignId, campaignId))
      .orderBy(desc(auditLog.id))
      .limit(limit);
  }

  /**
   * #23: the server-wide admin trail — every row NOT tied to a campaign
   * (campaign_id IS NULL): user create/disable/delete, settings changes,
   * rule-pack installs, admin token mints. Server-admin only (see controller).
   */
  async listServerAdmin(limit = 100) {
    return this.db
      .select()
      .from(auditLog)
      .where(isNull(auditLog.campaignId))
      .orderBy(desc(auditLog.id))
      .limit(limit);
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
