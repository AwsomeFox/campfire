import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { EntityType, Proposal, ProposalAction, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { proposals } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

export type ProposableEntityType = Exclude<EntityType, 'campaign'>;

const PROPOSABLE_ENTITY_TYPES: ProposableEntityType[] = ['quest', 'npc', 'location', 'session', 'character'];

export function isProposableEntityType(value: string): value is ProposableEntityType {
  return (PROPOSABLE_ENTITY_TYPES as string[]).includes(value);
}

export function toDomain(row: typeof proposals.$inferSelect): Proposal {
  return {
    id: row.id,
    campaignId: row.campaignId,
    entityType: row.entityType as EntityType,
    entityId: row.entityId,
    action: row.action as ProposalAction,
    payload: fromJsonText<Record<string, unknown>>(row.payload, {}),
    proposer: row.proposer,
    status: row.status as Proposal['status'],
    resolvedBy: row.resolvedBy,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Plain CRUD over the `proposals` table — no dependency on any domain module
 * (quests/npcs/locations/sessions/characters), so it can be imported by
 * those modules' controllers (for the write-path `?proposed=true` flow)
 * without creating a cycle with ProposalsModule (which depends on the
 * domain services to APPLY an approved proposal).
 */
@Injectable()
export class ProposalRecordsService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async create(
    campaignId: number,
    entityType: ProposableEntityType,
    entityId: number | null,
    action: ProposalAction,
    payload: Record<string, unknown>,
    user: RequestUser,
    role: Role,
  ): Promise<Proposal> {
    const ts = nowIso();
    const [row] = await this.db
      .insert(proposals)
      .values({
        campaignId,
        entityType,
        entityId,
        action,
        payload: toJsonText(payload),
        proposer: auditActor(user),
        status: 'pending',
        resolvedBy: '',
        note: '',
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'proposal.create',
      entityType: row.entityType,
      entityId: row.id,
      campaignId,
      detail: `${action} ${entityType}${entityId ? ` #${entityId}` : ''}`,
    });

    return toDomain(row);
  }

  async listForCampaign(campaignId: number, status: string | undefined): Promise<Proposal[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.campaignId, campaignId))
      .orderBy(desc(proposals.id));
    const all = rows.map(toDomain);
    return status ? all.filter((p) => p.status === status) : all;
  }

  async latestForCampaign(campaignId: number, limit = 500): Promise<Proposal[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.campaignId, campaignId))
      .orderBy(desc(proposals.id))
      .limit(limit);
    return rows.map(toDomain);
  }

  async getRowOrThrow(id: number) {
    const [row] = await this.db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Proposal ${id} not found`);
    return row;
  }

  async markResolved(
    id: number,
    status: 'approved' | 'rejected',
    note: string,
    user: RequestUser,
  ): Promise<Proposal> {
    const [row] = await this.db
      .update(proposals)
      .set({ status, resolvedBy: auditActor(user), note, updatedAt: nowIso() })
      .where(eq(proposals.id, id))
      .returning();
    return toDomain(row);
  }
}
