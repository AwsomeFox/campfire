import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import fs from 'node:fs';
import { asc, count, eq, inArray } from 'drizzle-orm';
import type { AuditActorRole, FsCleanupSummary } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { attachments, campaigns, fsDeletionQueue } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import {
  FS_DELETION_FAILED_ATTEMPTS,
  FS_DELETION_RETRY_INTERVAL_MS,
  removePathVerified,
} from './fs-deletion.util';
import { uploadsAbsolutePath, uploadsRelativePath, uploadsRoot } from './uploads-path';

/** Max queue rows returned in GET /admin/storage fsCleanup.items (counts stay exact). */
const FS_CLEANUP_SUMMARY_ITEMS_LIMIT = 100;
/** Max drainable rows processed per boot/interval/manual drain pass (oldest first). */
const FS_DRAIN_BATCH_LIMIT = 100;

export type FsDeletionScope = 'attachment' | 'campaign_purge';
export type FsDeletionQueueStatus = 'held' | 'pending' | 'failed';

export interface FsDeletionAuditContext {
  scope: FsDeletionScope;
  auditPrefix: string;
  actor: string;
  actorRole: AuditActorRole;
  campaignId: number | null;
  entityType: string;
  entityId: number | null;
}

export interface FsDeletionOutcome {
  filesPending: boolean;
  pendingPaths: string[];
}

@Injectable()
export class FsDeletionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FsDeletionService.name);
  /** Serialize drain runs so boot/interval/manual cannot overlap. */
  private drainInFlight: Promise<number> | null = null;

  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.drainQueue('boot');
    const timer = setInterval(() => {
      void this.drainQueue('interval');
    }, FS_DELETION_RETRY_INTERVAL_MS);
    timer.unref();
  }

  /** Stage audit: operator or user initiated irreversible metadata removal. */
  async auditRequested(ctx: FsDeletionAuditContext): Promise<void> {
    await this.audit.log({
      actor: ctx.actor,
      actorRole: ctx.actorRole,
      action: `${ctx.auditPrefix}.requested`,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      campaignId: ctx.campaignId,
    });
  }

  /** DB rows are gone; filesystem cleanup has not been verified yet. */
  async auditMetadataComplete(ctx: FsDeletionAuditContext, detail?: string): Promise<void> {
    await this.audit.log({
      actor: ctx.actor,
      actorRole: ctx.actorRole,
      action: `${ctx.auditPrefix}.metadata_complete`,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      campaignId: ctx.campaignId,
      detail: detail ?? '',
    });
  }

  /**
   * Durably reserve upload paths for erasure BEFORE metadata deletion commits.
   * Rows are inserted as `held` so drainQueue will NOT erase bytes while the
   * attachment/campaign metadata still exists (orchestrator / #727).
   * After metadata commit, completeReservedUploadPaths arms/erases them.
   */
  async reserveUploadPaths(
    absolutePaths: string[],
    ctx: FsDeletionAuditContext,
  ): Promise<Array<{ abs: string; rel: string; kind: 'file' | 'directory' }>> {
    const planned: Array<{ abs: string; rel: string; kind: 'file' | 'directory' }> = [];
    for (const abs of absolutePaths) {
      let rel: string;
      try {
        rel = uploadsRelativePath(abs);
      } catch (err) {
        // Fail closed: never delete metadata if a path cannot be queued for durable cleanup.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Refusing to reserve invalid upload path ${abs}: ${message}`);
        throw new Error(`Cannot reserve upload path for verified erasure: ${message}`, { cause: err });
      }
      let kind: 'file' | 'directory' = 'file';
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) kind = 'directory';
      } catch {
        /* path may already be gone — still reserve so drain can no-op cleanly */
      }
      await this.enqueue(rel, {
        kind,
        scope: ctx.scope,
        campaignId: ctx.campaignId,
        entityId: ctx.entityId,
        error: 'awaiting metadata deletion before verified erasure',
        status: 'held',
      });
      planned.push({ abs, rel, kind });
    }
    return planned;
  }

  /**
   * After metadata deletion: verify FS removal for reserved paths, dequeue successes,
   * and emit filesystem audit stages. Failures are armed as `pending` for drain retry.
   */
  async completeReservedUploadPaths(
    planned: Array<{ abs: string; rel: string; kind: 'file' | 'directory' }>,
    ctx: FsDeletionAuditContext,
  ): Promise<FsDeletionOutcome> {
    const pendingPaths: string[] = [];
    for (const { abs, rel, kind } of planned) {
      const result = removePathVerified(abs, {
        recursive: true,
        rmSync: fs.rmSync.bind(fs),
        existsSync: fs.existsSync.bind(fs),
      });
      if (result.ok) {
        await this.db.delete(fsDeletionQueue).where(eq(fsDeletionQueue.relPath, rel));
        continue;
      }
      pendingPaths.push(rel);
      await this.enqueue(rel, {
        kind,
        scope: ctx.scope,
        campaignId: ctx.campaignId,
        entityId: ctx.entityId,
        error: `${result.code}: ${result.message}`,
        status: 'pending',
      });
    }

    if (pendingPaths.length === 0) {
      await this.audit.log({
        actor: ctx.actor,
        actorRole: ctx.actorRole,
        action: `${ctx.auditPrefix}.filesystem_complete`,
        entityType: ctx.entityType,
        entityId: ctx.entityId,
        campaignId: ctx.campaignId,
      });
      return { filesPending: false, pendingPaths: [] };
    }

    await this.audit.log({
      actor: ctx.actor,
      actorRole: ctx.actorRole,
      action: `${ctx.auditPrefix}.filesystem_failed`,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      campaignId: ctx.campaignId,
      detail: pendingPaths.join(', '),
    });
    return { filesPending: true, pendingPaths };
  }

  async listPendingSummary(): Promise<FsCleanupSummary> {
    const [pendingRow] = await this.db
      .select({ value: count() })
      .from(fsDeletionQueue)
      .where(eq(fsDeletionQueue.status, 'pending'));
    const [failedRow] = await this.db
      .select({ value: count() })
      .from(fsDeletionQueue)
      .where(eq(fsDeletionQueue.status, 'failed'));
    const [queueRow] = await this.db.select({ value: count() }).from(fsDeletionQueue);
    // Oldest first by createdAt (updatedAt moves on every retry).
    const rows = await this.db
      .select()
      .from(fsDeletionQueue)
      .orderBy(asc(fsDeletionQueue.createdAt), asc(fsDeletionQueue.id))
      .limit(FS_CLEANUP_SUMMARY_ITEMS_LIMIT);
    return {
      pendingCount: pendingRow?.value ?? 0,
      failedCount: failedRow?.value ?? 0,
      queueCount: queueRow?.value ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        relPath: r.relPath,
        scope: r.scope as FsDeletionScope,
        status: r.status as FsDeletionQueueStatus,
        attempts: r.attempts,
        lastError: r.lastError,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /** Retry every drainable queued path (boot + background interval + manual). */
  async drainQueue(trigger: 'boot' | 'interval' | 'manual'): Promise<number> {
    if (this.drainInFlight) {
      if (trigger === 'interval') return this.drainInFlight;
      return this.drainInFlight.then(() => this.drainQueue(trigger));
    }

    this.drainInFlight = this.runDrain(trigger).finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  private async runDrain(trigger: 'boot' | 'interval' | 'manual'): Promise<number> {
    await this.reconcileHeldRows();

    // Bounded oldest-first batch so a broken volume cannot make every drain a full-table scan.
    const rows = await this.db
      .select()
      .from(fsDeletionQueue)
      .where(inArray(fsDeletionQueue.status, ['pending', 'failed']))
      .orderBy(asc(fsDeletionQueue.createdAt), asc(fsDeletionQueue.id))
      .limit(FS_DRAIN_BATCH_LIMIT);
    let cleared = 0;
    for (const row of rows) {
      let abs: string;
      try {
        abs = uploadsAbsolutePath(row.relPath);
      } catch (err) {
        this.logger.error(
          `Skipping invalid fs_deletion_queue path ${row.relPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await this.db.delete(fsDeletionQueue).where(eq(fsDeletionQueue.id, row.id));
        cleared += 1;
        continue;
      }

      const result = removePathVerified(abs, {
        recursive: true,
        rmSync: fs.rmSync.bind(fs),
        existsSync: fs.existsSync.bind(fs),
      });

      if (result.ok) {
        await this.db.delete(fsDeletionQueue).where(eq(fsDeletionQueue.id, row.id));
        cleared += 1;
        await this.audit.log({
          actor: 'system',
          actorRole: 'admin',
          action: 'storage.fs_cleanup.complete',
          entityType: 'storage',
          entityId: row.id,
          campaignId: row.campaignId,
          detail: `${row.relPath} (${trigger})`,
        });
        continue;
      }

      const attempts = row.attempts + 1;
      const status = attempts >= FS_DELETION_FAILED_ATTEMPTS ? 'failed' : 'pending';
      await this.db
        .update(fsDeletionQueue)
        .set({
          attempts,
          status,
          lastError: `${result.code}: ${result.message}`,
          updatedAt: nowIso(),
        })
        .where(eq(fsDeletionQueue.id, row.id));

      if (status === 'failed' && row.status !== 'failed') {
        this.logger.warn(
          `Filesystem cleanup failed for ${row.relPath} after ${attempts} attempts (${result.code})`,
        );
      }
    }
    return cleared;
  }

  /**
   * Crash recovery for `held` reservations:
   * - metadata still present → abandon the hold (do not delete live files)
   * - metadata gone → arm as pending so drain can erase orphans
   */
  private async reconcileHeldRows(): Promise<void> {
    const held = await this.db.select().from(fsDeletionQueue).where(eq(fsDeletionQueue.status, 'held'));
    for (const row of held) {
      const metadataAlive = await this.isReservedMetadataAlive(row.scope, row.entityId, row.campaignId);
      if (metadataAlive) {
        await this.db.delete(fsDeletionQueue).where(eq(fsDeletionQueue.id, row.id));
        this.logger.warn(
          `Abandoned held fs cleanup for ${row.relPath}: metadata still present (incomplete delete)`,
        );
        continue;
      }
      await this.db
        .update(fsDeletionQueue)
        .set({
          status: 'pending',
          lastError: 'armed after metadata loss (crash recovery)',
          updatedAt: nowIso(),
        })
        .where(eq(fsDeletionQueue.id, row.id));
    }
  }

  private async isReservedMetadataAlive(
    scope: string,
    entityId: number | null,
    campaignId: number | null,
  ): Promise<boolean> {
    if (scope === 'attachment' && entityId != null) {
      const [row] = await this.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(eq(attachments.id, entityId))
        .limit(1);
      return Boolean(row);
    }
    if (scope === 'campaign_purge' && campaignId != null) {
      const [row] = await this.db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(eq(campaigns.id, campaignId))
        .limit(1);
      return Boolean(row);
    }
    // Unknown scope / missing ids: fail closed — do not erase.
    return true;
  }

  private async enqueue(
    relPath: string,
    params: {
      kind: 'file' | 'directory';
      scope: FsDeletionScope;
      campaignId: number | null;
      entityId: number | null;
      error: string;
      status: FsDeletionQueueStatus;
    },
  ): Promise<void> {
    if (relPath === '' || relPath.trim() === '') {
      this.logger.error('Refusing to enqueue empty relPath (would target uploads root)');
      return;
    }
    const now = nowIso();
    await this.db
      .insert(fsDeletionQueue)
      .values({
        relPath,
        kind: params.kind,
        scope: params.scope,
        campaignId: params.campaignId,
        entityId: params.entityId,
        status: params.status,
        attempts: 0,
        lastError: params.error,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: fsDeletionQueue.relPath,
        set: {
          lastError: params.error,
          updatedAt: now,
          status: params.status,
          // New held reservation or re-arm after a fresh failure cycle starts at 0.
          // Preserving attempts across unrelated retries would leave stale "failed"
          // rows that never get another full drain budget after metadata is gone.
          attempts: 0,
          scope: params.scope,
          campaignId: params.campaignId,
          entityId: params.entityId,
          kind: params.kind,
        },
      });
  }

  /** Exposed for tests — uploads root path. */
  uploadsRoot(): string {
    return uploadsRoot();
  }
}
