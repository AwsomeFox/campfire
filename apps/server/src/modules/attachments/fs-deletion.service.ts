import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import fs from 'node:fs';
import { count, eq } from 'drizzle-orm';
import type { AuditActorRole, FsCleanupSummary } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { fsDeletionQueue } from '../../db/schema';
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

export type FsDeletionScope = 'attachment' | 'campaign_purge';

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
   * Durably reserve upload paths for erasure BEFORE metadata deletion commits, then
   * attempt verified removal. Crash between reserve+metadata commit and FS remove
   * leaves retryable queue rows (issue #727). Paths that erase successfully are
   * dequeued immediately.
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
        this.logger.error(
          `Refusing to reserve invalid upload path ${abs}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
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
        error: 'awaiting verified erasure',
      });
      planned.push({ abs, rel, kind });
    }
    return planned;
  }

  /**
   * After metadata deletion: verify FS removal for reserved paths, dequeue successes,
   * and emit filesystem audit stages.
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

  /** Convenience: reserve → caller deletes metadata → complete. Prefer split APIs for crash safety. */
  async removeUploadPaths(
    absolutePaths: string[],
    ctx: FsDeletionAuditContext,
  ): Promise<FsDeletionOutcome> {
    const planned = await this.reserveUploadPaths(absolutePaths, ctx);
    return this.completeReservedUploadPaths(planned, ctx);
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
    const rows = await this.db
      .select()
      .from(fsDeletionQueue)
      .orderBy(fsDeletionQueue.updatedAt)
      .limit(FS_CLEANUP_SUMMARY_ITEMS_LIMIT);
    return {
      pendingCount: pendingRow?.value ?? 0,
      failedCount: failedRow?.value ?? 0,
      queueCount: queueRow?.value ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        relPath: r.relPath,
        scope: r.scope as FsDeletionScope,
        status: r.status as 'pending' | 'failed',
        attempts: r.attempts,
        lastError: r.lastError,
        updatedAt: r.updatedAt,
      })),
    };
  }

  /** Retry every queued path (boot + background interval). */
  async drainQueue(trigger: 'boot' | 'interval' | 'manual'): Promise<number> {
    const rows = await this.db.select().from(fsDeletionQueue);
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

  private async enqueue(
    relPath: string,
    params: {
      kind: 'file' | 'directory';
      scope: FsDeletionScope;
      campaignId: number | null;
      entityId: number | null;
      error: string;
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
        status: 'pending',
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
          status: 'pending',
          attempts: 0,
        },
      });
  }

  /** Exposed for tests — uploads root path. */
  uploadsRoot(): string {
    return uploadsRoot();
  }
}
