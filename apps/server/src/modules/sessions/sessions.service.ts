import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { SessionCreate, SessionUpdate } from '@campfire/schema';
import type { Session, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { sessions, sessionShares, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type SessionCreateInput = z.infer<typeof SessionCreate>;
type SessionUpdateInput = z.infer<typeof SessionUpdate>;

export function toDomain(row: typeof sessions.$inferSelect): Session {
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

  /**
   * campaign.sessionCount is a denormalized COUNT(*) of this campaign's sessions —
   * recomputed (never bumped/guessed) on every create/delete so it stays accurate
   * regardless of session numbering (which may have gaps or be renumbered) or deletes
   * (which previously never decremented it at all).
   */
  private async recomputeSessionCount(campaignId: number): Promise<void> {
    const rows = await this.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId));
    await this.db.update(campaigns).set({ sessionCount: rows.length, updatedAt: nowIso() }).where(eq(campaigns.id, campaignId));
  }

  /** Session `number` must be unique within a campaign — 409 on a duplicate. */
  private async assertNumberAvailable(campaignId: number, number: number, excludeId?: number): Promise<void> {
    const conflict = excludeId
      ? and(eq(sessions.campaignId, campaignId), eq(sessions.number, number), ne(sessions.id, excludeId))
      : and(eq(sessions.campaignId, campaignId), eq(sessions.number, number));
    const [row] = await this.db.select({ id: sessions.id }).from(sessions).where(conflict).limit(1);
    if (row) throw new ConflictException(`Session number ${number} already exists in this campaign`);
  }

  async create(campaignId: number, input: SessionCreateInput, user: RequestUser, role: Role): Promise<Session> {
    await this.assertNumberAvailable(campaignId, input.number);
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

    await this.recomputeSessionCount(campaignId);

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.create',
      entityType: 'session',
      entityId: row.id,
      campaignId,
    });
    return toDomain(row);
  }

  async update(id: number, input: SessionUpdateInput, user: RequestUser, role: Role): Promise<Session> {
    const existing = await this.getRowOrThrow(id);
    if (input.number !== undefined) {
      await this.assertNumberAvailable(existing.campaignId, input.number, id);
    }
    const [row] = await this.db
      .update(sessions)
      .set({ ...input, updatedAt: nowIso() })
      .where(eq(sessions.id, id))
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.update',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
    return toDomain(row);
  }

  async remove(id: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getRowOrThrow(id);
    await this.db.delete(sessions).where(eq(sessions.id, id));
    // Hygiene: drop this session's share links too. The public resolver joins
    // through to the live session row, so orphaned links would already 404 —
    // this just keeps the table from accumulating dead rows.
    await this.db.delete(sessionShares).where(eq(sessionShares.sessionId, id));
    await this.recomputeSessionCount(existing.campaignId);
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.delete',
      entityType: 'session',
      entityId: id,
      campaignId: existing.campaignId,
    });
  }
}
