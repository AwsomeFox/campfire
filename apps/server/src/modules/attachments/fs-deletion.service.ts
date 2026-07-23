import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
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
   * Remove absolute paths under uploads/, enqueue any path that could not be verified
   * gone, and emit filesystem audit stages.
   */
  async removeUploadPaths(
    absolutePaths: string[],
    ctx: FsDeletionAuditContext,
  ): Promise<FsDeletionOutcome> {
    const pendingPaths: string[] = [];
    for (const abs of absolutePaths) {
      let rel: string;
      try {
        rel = uploadsRelativePath(abs);
      } catch (err) {
        this.logger.error(
          `Refusing to enqueue invalid upload path ${abs}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      const result = removePathVerified(abs, {
        recursive: true,
        rmSync: fs.rmSync.bind(fs),
        existsSync: fs.existsSync.bind(fs),
      });
      if (result.ok) continue;

      let kind: 'file' | 'directory' = 'file';
      try {
        if (fs.statSync(abs).isDirectory()) kind = 'directory';
      } catch {
        /* path may have disappeared between remove attempt and enqueue */
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

  async listPendingSummary(): Promise<FsCleanupSummary> {
    const rows = await this.db.select().from(fsDeletionQueue).orderBy(fsDeletionQueue.updatedAt);
    const pendingCount = rows.filter((r) => r.status === 'pending').length;
    const failedCount = rows.filter((r) => r.status === 'failed').length;
    return {
      pendingCount,
      failedCount,
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
