import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { SessionCreate, SessionUpdate } from '@campfire/schema';
import type { Session } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { sessions, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import type { RequestUser } from '../../common/user.types';

type SessionCreateInput = z.infer<typeof SessionCreate>;
type SessionUpdateInput = z.infer<typeof SessionUpdate>;

function toDomain(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    campaignId: row.campaignId,
    number: row.number,
    title: row.title,
    playedAt: row.playedAt,
    recap: row.recap,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class SessionsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(campaignId: number): Promise<Session[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.campaignId, campaignId))
      .orderBy(desc(sessions.number));
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Session ${id} not found`);
    return row;
  }

  async getOrThrow(id: number): Promise<Session> {
    const row = await this.getRowOrThrow(id);
    return toDomain(row);
  }

  /** bump campaign.sessionCount to max(current, count) */
  private async bumpSessionCount(campaignId: number, count: number): Promise<void> {
    const [campaign] = await this.db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (campaign && count > campaign.sessionCount) {
      await this.db
        .update(campaigns)
        .set({ sessionCount: count, updatedAt: nowIso() })
        .where(eq(campaigns.id, campaignId));
    }
  }

  async create(campaignId: number, input: SessionCreateInput, user: RequestUser): Promise<Session> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(sessions)
      .values({
        campaignId,
        number: input.number,
        title: input.title ?? '',
        playedAt: input.playedAt ?? null,
        recap: input.recap ?? '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.bumpSessionCount(campaignId, input.number);

    await this.audit.log({
      actor: user.id,
      actorRole: user.role,
      action: 'session.create',
      entityType: 'session',
      entityId: row.id,
      campaignId,
    });
    return toDomain(row);
  }

  async update(id: number, input: SessionUpdateInput, user: RequestUser): Promise<Session> {
    const existing = await this.getRowOrThrow(id);
    const [row] = await this.db
      .update(sessions)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(sessions.id, id))
      .returning();

    if (input.number !== undefined) {
      await this.bumpSessionCount(existing.campaignId, input.number);
    }

    await this.audit.log({
      actor: user.id,
      actorRole: user.role,
      action: 'session.update',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return toDomain(row);
  }

  async remove(id: number, user: RequestUser): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.db.delete(sessions).where(eq(sessions.id, id));
    await this.audit.log({
      actor: user.id,
      actorRole: user.role,
      action: 'session.delete',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }
}
