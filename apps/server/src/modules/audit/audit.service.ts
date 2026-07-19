import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { auditLog } from '../../db/schema';
import { nowIso } from '../../common/time';

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: DrizzleDb) {}

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
}
