import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { MemberCreate, MemberUpdate } from '@campfire/schema';
import type { CampaignMember } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, users, characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type MemberCreateInput = z.infer<typeof MemberCreate>;
type MemberUpdateInput = z.infer<typeof MemberUpdate>;

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForCampaign(campaignId: number): Promise<CampaignMember[]> {
    const rows = await this.db
      .select({
        id: campaignMembers.id,
        campaignId: campaignMembers.campaignId,
        userId: campaignMembers.userId,
        role: campaignMembers.role,
        characterId: campaignMembers.characterId,
        createdAt: campaignMembers.createdAt,
        updatedAt: campaignMembers.updatedAt,
        username: users.username,
        displayName: users.displayName,
      })
      .from(campaignMembers)
      .leftJoin(users, eq(campaignMembers.userId, users.id))
      .where(eq(campaignMembers.campaignId, campaignId));

    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaignId,
      userId: r.userId,
      role: r.role as CampaignMember['role'],
      characterId: r.characterId,
      username: r.username ?? '',
      displayName: r.displayName ?? '',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async getRowOrThrow(campaignId: number, memberId: number) {
    const [row] = await this.db
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.id, memberId), eq(campaignMembers.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Member ${memberId} not found`);
    return row;
  }

  private async dmCount(campaignId: number, excludeMemberId?: number): Promise<number> {
    const rows = await this.db
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.role, 'dm')));
    return rows.filter((r) => r.id !== excludeMemberId).length;
  }

  /** Auto-inserts the creator as 'dm' when a campaign is created (skipped for dev:* users). */
  async addCreatorAsDm(campaignId: number, userId: number): Promise<void> {
    const ts = nowIso();
    await this.db
      .insert(campaignMembers)
      .values({ campaignId, userId, role: 'dm', characterId: null, createdAt: ts, updatedAt: ts })
      .onConflictDoNothing();
  }

  /**
   * characterId is an FK-shaped field that previously accepted any integer with no
   * existence/campaign check — a nonexistent id, or another campaign's character id,
   * would silently pass through and get denormalized-joined against on listForCampaign.
   */
  private async validateCharacterRef(characterId: number | null | undefined, campaignId: number): Promise<void> {
    if (characterId == null) return;
    const [row] = await this.db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);
  }

  /**
   * Issue #32: linking a member to a character grants that player edit rights by syncing
   * characters.ownerUserId (the string form of users.id — see UserIdRef in @campfire/schema;
   * campaignMembers.userId is the raw integer) instead of requiring the DM to also PATCH
   * the character's ownerUserId by hand. Unlinking (or re-linking to another character)
   * clears ownership only when the character is still owned by this member, so an explicit
   * DM reassignment via PATCH /characters/:id is never clobbered.
   */
  private async syncCharacterOwnership(
    userId: number,
    previousCharacterId: number | null,
    nextCharacterId: number | null,
  ): Promise<void> {
    if (previousCharacterId === nextCharacterId) return;
    const ownerUserId = String(userId);
    if (previousCharacterId != null) {
      await this.db
        .update(characters)
        .set({ ownerUserId: null, updatedAt: nowIso() })
        .where(and(eq(characters.id, previousCharacterId), eq(characters.ownerUserId, ownerUserId)));
    }
    if (nextCharacterId != null) {
      await this.db
        .update(characters)
        .set({ ownerUserId, updatedAt: nowIso() })
        .where(eq(characters.id, nextCharacterId));
    }
  }

  async create(campaignId: number, input: MemberCreateInput, actor: RequestUser): Promise<CampaignMember> {
    const [existing] = await this.db
      .select()
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, input.userId)))
      .limit(1);
    if (existing) throw new ConflictException('User is already a member of this campaign');
    await this.validateCharacterRef(input.characterId, campaignId);

    const ts = nowIso();
    const [row] = await this.db
      .insert(campaignMembers)
      .values({
        campaignId,
        userId: input.userId,
        role: input.role,
        characterId: input.characterId ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.syncCharacterOwnership(input.userId, null, input.characterId ?? null);

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'member.create',
      entityType: 'campaign_member',
      entityId: row.id,
      campaignId,
      detail: `user=${input.userId} role=${input.role}`,
    });

    const [full] = await this.listForCampaign(campaignId).then((all) => all.filter((m) => m.id === row.id));
    return full;
  }

  async update(campaignId: number, memberId: number, input: MemberUpdateInput, actor: RequestUser): Promise<CampaignMember> {
    const existing = await this.getRowOrThrow(campaignId, memberId);

    const demotingLastDm = input.role !== undefined && input.role !== 'dm' && existing.role === 'dm';
    if (demotingLastDm) {
      const remaining = await this.dmCount(campaignId, memberId);
      if (remaining === 0) {
        throw new ConflictException('Cannot demote the last dm of this campaign');
      }
    }
    await this.validateCharacterRef(input.characterId, campaignId);

    const update: Partial<typeof campaignMembers.$inferInsert> = { updatedAt: nowIso() };
    if (input.role !== undefined) update.role = input.role;
    if (input.characterId !== undefined) update.characterId = input.characterId;

    await this.db.update(campaignMembers).set(update).where(eq(campaignMembers.id, memberId));

    if (input.characterId !== undefined) {
      await this.syncCharacterOwnership(existing.userId, existing.characterId, input.characterId);
    }

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'member.update',
      entityType: 'campaign_member',
      entityId: memberId,
      campaignId,
      detail: JSON.stringify(input),
    });

    const all = await this.listForCampaign(campaignId);
    const updated = all.find((m) => m.id === memberId);
    if (!updated) throw new NotFoundException(`Member ${memberId} not found`);
    return updated;
  }

  async remove(campaignId: number, memberId: number, actor: RequestUser): Promise<void> {
    const existing = await this.getRowOrThrow(campaignId, memberId);

    if (existing.role === 'dm') {
      const remaining = await this.dmCount(campaignId, memberId);
      if (remaining === 0) {
        throw new ConflictException('Cannot remove the last dm of this campaign');
      }
    }

    await this.db.delete(campaignMembers).where(eq(campaignMembers.id, memberId));

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: 'dm',
      action: 'member.delete',
      entityType: 'campaign_member',
      entityId: memberId,
      campaignId,
    });
  }
}
