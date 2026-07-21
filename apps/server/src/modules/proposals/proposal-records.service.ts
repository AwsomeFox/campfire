import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { EntityType, Proposal, ProposalAction, Role } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { proposals, quests, npcs, locations, sessions, characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { fromJsonText, toJsonText } from '../../common/json';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
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

// Encounters (issue #126) join EntityType for note-pinning, but combat state is not a
// proposable entity — exclude it alongside 'campaign' so the proposal schemas/snapshot
// maps stay exhaustive over exactly the entity types that CAN be proposed. Factions
// (issue #221) are likewise note-pinnable but not proposable in v1 (DM-write only).
export type ProposableEntityType = Exclude<EntityType, 'campaign' | 'encounter' | 'faction'>;

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
    proposerUserId: row.proposerUserId ?? '',
    proposerToken: row.proposerToken ?? null,
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
    private readonly notifications: NotificationsService,
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
    // Deletes snapshot too, so the DM can see exactly what would be removed.
    const snapshot = action !== 'create' && entityId !== null ? await this.snapshotEntity(entityType, entityId) : null;

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
        // Attribution (issue #124): record the actual USER — display name for the
        // human-readable `proposer`, their stable id for the self-view filter — even
        // when the write arrives over a PAT (RequestUser resolves to the token's owning
        // user). The token name is kept as secondary provenance, never the identity.
        proposer: user.name,
        proposerUserId: user.id,
        proposerToken: user.tokenContext ? user.tokenContext.name : null,
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

    // Tell the DM(s) a proposal is waiting (issue #263) — they own the review queue,
    // and previously a submission gave no signal at all. Fan out to every dm-role
    // member except the actor (a DM proposing to themselves needn't ping). No entity
    // deep-link: the target may not exist yet (create proposals) and the bell routes
    // proposal_* to the proposals queue. Best-effort — never fails the write.
    const roles = await this.notifications.memberRoles(campaignId);
    for (const [memberId, memberRole] of roles) {
      if (memberRole !== 'dm' || String(memberId) === user.id) continue;
      await this.notifications.notifyUser(memberId, campaignId, user, {
        type: 'proposal_submitted',
        title: `${user.name || 'A member'} proposed a ${action} to a ${entityType}`,
        actorName: user.name,
      });
    }

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

  /**
   * List a campaign's proposals, newest first. `opts.proposerUserId` scopes the
   * result to a single submitter — the proposer self-view (issue #124): a non-DM
   * member sees only what they authored, while the DM (no filter) sees everyone's.
   */
  async listForCampaign(
    campaignId: number,
    status: string | undefined,
    opts?: { proposerUserId?: string },
  ): Promise<Proposal[]> {
    const rows = await this.db
      .select()
      .from(proposals)
      .where(eq(proposals.campaignId, campaignId))
      .orderBy(desc(proposals.id));
    let all = rows.map(toDomain);
    if (opts?.proposerUserId !== undefined) {
      all = all.filter((p) => p.proposerUserId === opts.proposerUserId);
    }
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

  /**
   * Persist an amended payload for a still-pending proposal (edit-before-approve):
   * the DM tweaked the proposed create/update body at approval time, so the stored
   * record matches what actually gets applied. Guarded on `status = 'pending'` so a
   * concurrently-resolved proposal isn't rewritten.
   */
  async updatePayload(id: number, payload: Record<string, unknown>): Promise<void> {
    await this.db
      .update(proposals)
      .set({ payload: toJsonText(payload), updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')));
  }

  /**
   * Revise a still-pending proposal's payload (issue #124): the proposer amends
   * their own proposed create/update body before the DM acts. Guarded on
   * `status = 'pending'` so an already-resolved (or withdrawn) proposal isn't
   * rewritten. Returns the updated domain row, or null if it was no longer
   * pending (lost a race to a resolver). Ownership is checked by the caller.
   */
  async revisePayload(id: number, payload: Record<string, unknown>): Promise<Proposal | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ payload: toJsonText(payload), updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
      .returning();
    return row ? toDomain(row) : null;
  }

  /**
   * Backfill the created entity's id onto an approved create-proposal (issue #124):
   * once the create applies, the proposal record points at the row it produced, so
   * canon provenance survives acceptance. Guarded on `entity_id IS NULL` so it never
   * clobbers an already-set target, and applied right after the successful write.
   */
  async backfillEntityId(id: number, entityId: number): Promise<void> {
    await this.db
      .update(proposals)
      .set({ entityId, updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), isNull(proposals.entityId)));
  }

  /**
   * Withdraw a still-pending proposal (issue #124): a compare-and-set to the
   * `withdrawn` terminal state, guarded on BOTH `status = 'pending'` and the
   * proposer's own user id, so a member can only ever pull their own proposal and
   * only while it is still pending (a concurrent DM approve/reject wins the CAS).
   * Returns the withdrawn domain row, or null if the guard didn't match.
   */
  async markWithdrawn(id: number, proposerUserId: string): Promise<Proposal | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ status: 'withdrawn', updatedAt: nowIso() })
      .where(
        and(
          eq(proposals.id, id),
          eq(proposals.status, 'pending'),
          eq(proposals.proposerUserId, proposerUserId),
        ),
      )
      .returning();
    return row ? toDomain(row) : null;
  }

  /**
   * Atomically transition a proposal from `pending` to `approved`/`rejected`.
   * This is a compare-and-set: the `AND status='pending'` guard means SQLite
   * only touches the row if it is still pending, and `.returning()` reports
   * whether that row actually changed. Two concurrent approve/reject calls (DM
   * double-click, or web + MCP agent) therefore can't both win — exactly one
   * gets the row back; the other gets `null` and the caller raises 409. This
   * is the linchpin of the fix for issue #85: the status flip is the single
   * point of serialization, so the entity write downstream applies at most once.
   *
   * Returns the resolved domain row, or `null` if the proposal was not pending
   * (already resolved, or lost the race to a concurrent resolver).
   */
  async markResolved(
    id: number,
    status: 'approved' | 'rejected',
    note: string,
    user: RequestUser,
  ): Promise<Proposal | null> {
    const [row] = await this.db
      .update(proposals)
      .set({ status, resolvedBy: auditActor(user), note, updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
      .returning();
    return row ? toDomain(row) : null;
  }

  /**
   * Roll a claimed proposal back to `pending` (see ProposalsService.approve):
   * approve claims the row first, then applies the entity write. If that write
   * throws, this undoes the claim so the proposal is re-approvable rather than
   * stranded as `approved` with no write applied. Guarded on `status='approved'`
   * so it only ever reverts a claim this request made, never someone else's
   * resolution.
   */
  async revertToPending(id: number): Promise<void> {
    await this.db
      .update(proposals)
      .set({ status: 'pending', resolvedBy: '', note: '', updatedAt: nowIso() })
      .where(and(eq(proposals.id, id), eq(proposals.status, 'approved')))
      .returning();
  }
}
