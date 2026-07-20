import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { EntityType, Proposal, ProposalAction, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { proposals, quests, npcs, locations, sessions, characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
// Pure row->domain mappers only (NOT the injectable services) — importing these
// creates no Nest module cycle, and keeps the snapshot shape exactly in sync
// with what each entity's read endpoints return.
import { toDomain as questToDomain } from '../quests/quests.service';
import { toDomain as npcToDomain } from '../npcs/npcs.service';
import { toDomain as locationToDomain } from '../locations/locations.service';
import { toDomain as sessionToDomain } from '../sessions/sessions.service';
import { toDomain as characterToDomain } from '../characters/characters.service';

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
    snapshot: row.snapshot == null ? null : fromJsonText<Record<string, unknown> | null>(row.snapshot, null),
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
    // Capture the target's current state so the DM review UI can show a real
    // before/after diff (issue #3). Creates have no "before"; snapshot stays null.
    const snapshot = action === 'update' && entityId !== null ? await this.snapshotEntity(entityType, entityId) : null;

    const ts = nowIso();
    const [row] = await this.db
      .insert(proposals)
      .values({
        campaignId,
        entityType,
        entityId,
        action,
        payload: toJsonText(payload),
        snapshot: snapshot === null ? null : toJsonText(snapshot),
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

  /**
   * Domain-shaped state of the target entity right now, or null if it doesn't
   * exist (the entity could be deleted between the caller's existence check and
   * here; approve would 404 later anyway, and a null snapshot just means the UI
   * shows proposed values without a "before" column). Snapshots are stored
   * unredacted (dmSecret included) — proposals are only readable via dm-gated
   * endpoints, matching what the dm sees on the entity itself.
   */
  private async snapshotEntity(entityType: ProposableEntityType, entityId: number): Promise<Record<string, unknown> | null> {
    switch (entityType) {
      case 'quest': {
        const [row] = await this.db.select().from(quests).where(eq(quests.id, entityId)).limit(1);
        return row ? { ...questToDomain(row) } : null;
      }
      case 'npc': {
        const [row] = await this.db.select().from(npcs).where(eq(npcs.id, entityId)).limit(1);
        return row ? { ...npcToDomain(row) } : null;
      }
      case 'location': {
        const [row] = await this.db.select().from(locations).where(eq(locations.id, entityId)).limit(1);
        return row ? { ...locationToDomain(row) } : null;
      }
      case 'session': {
        const [row] = await this.db.select().from(sessions).where(eq(sessions.id, entityId)).limit(1);
        return row ? { ...sessionToDomain(row) } : null;
      }
      case 'character': {
        const [row] = await this.db.select().from(characters).where(eq(characters.id, entityId)).limit(1);
        return row ? { ...characterToDomain(row) } : null;
      }
    }
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
