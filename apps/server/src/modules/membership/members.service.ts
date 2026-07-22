import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { MemberCreate, MemberUpdate } from '@campfire/schema';
import type { CampaignMember } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, campaigns, users, characters } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type MemberCreateInput = z.infer<typeof MemberCreate>;
type MemberUpdateInput = z.infer<typeof MemberUpdate>;

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly events: CampaignEventsService,
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

    // Notify the added user (not the acting DM). Best-effort inside NotificationsService.
    const [campaign] = await this.db
      .select({ name: campaigns.name })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .limit(1);
    await this.notifications.notifyUser(input.userId, campaignId, actor, {
      type: 'added_to_campaign',
      title: `You were added to ${campaign?.name ?? 'a campaign'} as ${input.role}`,
      entityType: 'campaign',
      entityId: campaignId,
      actorName: actor.name,
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

  /**
   * Removes a membership. Two callers, gated in the controller:
   *  - a dm removing anyone (`selfLeave` unset) — the pre-existing behavior, and
   *  - a member removing THEIR OWN seat (self-leave, issue #128 player data rights).
   *
   * The last-dm guard applies to both: a sole dm can neither be removed nor
   * self-leave without first handing dm off (409), so a campaign is never
   * orphaned dm-less.
   *
   * Owned characters are DE-LINKED, never deleted: the character sheet stays in
   * the campaign (the party/DM keep the PC record) but the departing member's
   * edit rights — characters.ownerUserId, the string form of users.id — are
   * cleared, so a closed seat can no longer mutate its sheet. This mirrors the
   * unlink half of syncCharacterOwnership(). Authored notes/proposals are left
   * intact and attributed (history preserved, not orphaned or hard-deleted —
   * never destroy other people's data).
   */
  async remove(campaignId: number, memberId: number, actor: RequestUser, opts?: { selfLeave?: boolean }): Promise<void> {
    const existing = await this.getRowOrThrow(campaignId, memberId);

    if (existing.role === 'dm') {
      const remaining = await this.dmCount(campaignId, memberId);
      if (remaining === 0) {
        throw new ConflictException(
          opts?.selfLeave
            ? 'You are the last dm of this campaign — hand dm off to someone else before leaving'
            : 'Cannot remove the last dm of this campaign',
        );
      }
    }

    await this.db.delete(campaignMembers).where(eq(campaignMembers.id, memberId));

    await this.db
      .update(characters)
      .set({ ownerUserId: null, updatedAt: nowIso() })
      .where(and(eq(characters.campaignId, campaignId), eq(characters.ownerUserId, String(existing.userId))));

    await this.audit.log({
      actor: auditActor(actor),
      actorRole: opts?.selfLeave ? (existing.role as CampaignMember['role']) : 'dm',
      action: opts?.selfLeave ? 'member.leave' : 'member.delete',
      entityType: 'campaign_member',
      entityId: memberId,
      campaignId,
    });

    // Issue #527: notify every open SSE subscriber that this user was removed so the
    // affected subscriber's own stream tears down immediately. The event is emitted AFTER
    // the DB delete succeeds so a rolled-back remove never disconnects anyone. It carries
    // no entity payload — only the affected userId/memberId — mirroring the thin-convention
    // of every other campaign event (subscribers refetch through permission-checked REST,
    // and the only consumer of THIS event type is the stream-termination filter). `userId`
    // is the String form of campaignMembers.userId so it matches RequestUser.id directly.
    this.events.emit({
      type: 'membership.revoked',
      campaignId,
      userId: String(existing.userId),
      memberId,
    });
  }
}
