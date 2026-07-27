import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type {
  EntityType,
  Role,
  SafetyBlockCreate,
  SafetyControl,
  SafetyControlKind,
  SafetyMuteCreate,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, memberSafetyControls, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { auditActor, type RequestUser } from '../../common/user.types';
import { assertAnchorVisible } from '../../common/anchor-visibility';
import { AuditService } from '../audit/audit.service';

/**
 * Personal safety controls (issue #597): block, sender mute, thread mute.
 *
 * WHO OWNS WHAT
 * -------------
 * Everything here belongs to the MEMBER who created it. A DM cannot list, create, or
 * lift another member's controls, and no endpoint discloses a control to the person it
 * names. The DM's tools are the separate moderation surface (#601 reports/quarantine
 * plus this issue's direct silence and the existing member removal) — a deliberate
 * split, because the two answer different questions: "protect me from this person" is
 * not the same request as "sanction this person at this table", and a member must be
 * able to make the first without opening a case against anyone.
 *
 * THE BLOCK MUST NOT REVEAL ITSELF — WHERE THAT IS ACTUALLY ENFORCED
 * ------------------------------------------------------------------
 * Nothing in this service runs on the blocked member's request path. Creating a block
 * writes one row and changes no behaviour that a sender can observe:
 *
 *   - A whisper aimed at someone who blocks you is accepted and stored EXACTLY as
 *     before. Same 201, same body, same latency, same audit row, same appearance in
 *     your own "sent" list. It simply never becomes a notification and never appears in
 *     the recipient's reads (NotificationsService.dispatch, NotesService.listForCampaign).
 *   - There is no delivery receipt anywhere in the API — no read state, no "delivered"
 *     flag on a note — so the absence of one leaks nothing.
 *   - "No notification row was written" is already an unremarkable outcome that predates
 *     this issue: a recipient whose notification category is set to `muted` produces the
 *     same absence (#789). A block is therefore indistinguishable from a preference the
 *     sender has no access to read.
 *   - The suppression query runs on EVERY dispatch, blocked or not, so a blocked send
 *     and an unblocked send do the same work in the same order.
 *
 * The rejected alternative was refusing the whisper — 403, or the existing "recipient
 * must be a member" 400 from resolveWhisperTarget. Both are perfect oracles: they tell a
 * harasser they were blocked, by whom, and when. That is the precise moment harassment
 * moves to a channel the server cannot see, and it is why a "block" that announces
 * itself is worse than none. The cost of the quieter design is honest and worth stating:
 * a blocked sender can keep talking into the void, and the words are still written down.
 * That is a feature for safeguarding — the DM and the moderation evidence path can still
 * see every one of them, which is exactly what a later report needs.
 *
 * MULTI-ACCOUNT EVASION — WHAT IS AND IS NOT CLOSED
 * -------------------------------------------------
 * A block is keyed on the ACCOUNT identity and is account-wide, not membership-scoped
 * and not campaign-scoped. That closes every re-entry route the server can actually see:
 * leaving and rejoining, being removed and re-invited, joining a DIFFERENT campaign the
 * blocker is also in, acting through a personal access token, being promoted, demoted,
 * or handed a temporary guest-DM grant. All of those keep the same `users.id`, so all of
 * them stay blocked.
 *
 * What it does NOT close, stated plainly rather than implied: a determined person who
 * registers a SECOND ACCOUNT. This server stores no device, IP, or session fingerprint
 * (see user_sessions — token hash, user id, timestamps, nothing else) and no verified
 * email, so there is no honest signal tying two accounts to one human. Guessing from
 * display names would produce false positives against innocent members who share a name,
 * which is a worse failure than the one it prevents. The answer to that case is
 * deliberately human and lives one layer up: a conduct report (#601) names the person,
 * the DM has silence and removal, and invite links are revocable. This is documented as
 * a limit rather than papered over.
 */
@Injectable()
export class SafetyService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Block a member of this campaign. The BLOCK is account-wide (`campaign_id` NULL) even
   * though it is created from a campaign context: the campaign is only how you found the
   * person, and the check that you share a table with them is what stops this endpoint
   * becoming a way to probe for account ids.
   *
   * Idempotent: re-blocking someone already blocked returns the existing control rather
   * than stacking rows, so a double-tap in the UI cannot produce a list full of duplicates
   * that must each be lifted separately.
   */
  async createBlock(
    campaignId: number,
    input: SafetyBlockCreate,
    user: RequestUser,
    role: Role,
  ): Promise<SafetyControl> {
    const target = input.targetUserId.trim();
    if (target === user.id) throw new BadRequestException('You cannot block yourself.');
    const targetName = await this.requireCampaignMemberName(campaignId, target);

    const existing = await this.findLive('block', user.id, { targetUserId: target });
    if (existing) return this.toDomain(existing, targetName);

    const [row] = await this.db
      .insert(memberSafetyControls)
      .values({
        campaignId: null, // account-wide by design — see the class doc.
        kind: 'block',
        ownerUserId: user.id,
        targetUserId: target,
        reason: input.reason?.slice(0, 500) ?? '',
        createdAt: nowIso(),
      })
      .returning();

    // Audited so a safeguarding review can reconstruct "when did this person stop being
    // reachable", but WITHOUT the target: the campaign audit log is DM-readable, and a
    // DM who can read "victim blocked abuser" can leak it, including to the abuser. The
    // owner is the actor, which they already are on every row they write; who they
    // blocked is theirs alone and stays out of the trail.
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'safety.block.create',
      entityType: 'member_safety_control',
      entityId: row.id,
      campaignId,
      detail: 'member created a personal block (subject deliberately not recorded)',
    });
    return this.toDomain(row, targetName);
  }

  /**
   * Mute a sender or a thread. Unlike a block this is pure noise control: the muted
   * member's content stays fully visible and their writes are unaffected — only the
   * bell stops. Scoped to the campaign it was created in, because "this thread is too
   * busy" is a statement about a table, not about a person.
   */
  async createMute(
    campaignId: number,
    input: SafetyMuteCreate,
    user: RequestUser,
    role: Role,
  ): Promise<SafetyControl> {
    const wantsSender = input.targetUserId != null && input.targetUserId.trim() !== '';
    const wantsThread = input.entityType != null && input.entityId != null;
    if (wantsSender === wantsThread) {
      throw new BadRequestException(
        'Provide either `targetUserId` (mute a person) or `entityType` + `entityId` (mute a thread), not both.',
      );
    }

    if (wantsSender) {
      const target = input.targetUserId!.trim();
      if (target === user.id) throw new BadRequestException('You cannot mute yourself.');
      const targetName = await this.requireCampaignMemberName(campaignId, target);
      const existing = await this.findLive('mute_sender', user.id, { targetUserId: target, campaignId });
      if (existing) return this.toDomain(existing, targetName);
      const [row] = await this.db
        .insert(memberSafetyControls)
        .values({
          campaignId,
          kind: 'mute_sender',
          ownerUserId: user.id,
          targetUserId: target,
          reason: input.reason?.slice(0, 500) ?? '',
          createdAt: nowIso(),
        })
        .returning();
      await this.logMute(campaignId, row.id, user, role, 'sender');
      return this.toDomain(row, targetName);
    }

    // A thread mute names an anchored entity, so it must pass the SAME visibility rule
    // the entity's own GET applies (issue #230) — otherwise muting would be a way to
    // probe for a hidden quest/NPC by watching which ids are accepted.
    await assertAnchorVisible(this.db, campaignId, input.entityType as EntityType, input.entityId!, role);
    const existing = await this.findLive('mute_thread', user.id, {
      campaignId,
      threadEntityType: input.entityType!,
      threadEntityId: input.entityId!,
    });
    if (existing) return this.toDomain(existing, '');
    const [row] = await this.db
      .insert(memberSafetyControls)
      .values({
        campaignId,
        kind: 'mute_thread',
        ownerUserId: user.id,
        threadEntityType: input.entityType!,
        threadEntityId: input.entityId!,
        reason: input.reason?.slice(0, 500) ?? '',
        createdAt: nowIso(),
      })
      .returning();
    await this.logMute(campaignId, row.id, user, role, 'thread');
    return this.toDomain(row, '');
  }

  /**
   * The caller's OWN controls, newest first. Account-wide blocks are always included
   * regardless of which campaign the request came through — a block list you can only
   * see from one table would be useless for managing it.
   */
  async listOwn(user: RequestUser): Promise<SafetyControl[]> {
    const rows = await this.db
      .select()
      .from(memberSafetyControls)
      .where(and(eq(memberSafetyControls.ownerUserId, user.id), isNull(memberSafetyControls.liftedAt))!)
      .orderBy(desc(memberSafetyControls.id));
    const names = await this.resolveNames(rows.map((r) => r.targetUserId).filter((id): id is string => id != null));
    return rows.map((row) => this.toDomain(row, row.targetUserId ? names.get(row.targetUserId) ?? '' : ''));
  }

  /**
   * Lift one of the caller's own controls. A control owned by anyone else is 404, not
   * 403: the id space is shared, and a 403 would confirm that some other member holds a
   * control with that id — which for a block is exactly the fact that must stay private.
   */
  async lift(controlId: number, user: RequestUser, role: Role, campaignId: number): Promise<void> {
    const [row] = await this.db
      .select()
      .from(memberSafetyControls)
      .where(and(eq(memberSafetyControls.id, controlId), isNull(memberSafetyControls.liftedAt))!)
      .limit(1);
    if (!row || row.ownerUserId !== user.id) throw new NotFoundException(`Safety control ${controlId} not found`);
    await this.db
      .update(memberSafetyControls)
      .set({ liftedAt: nowIso() })
      .where(eq(memberSafetyControls.id, controlId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: `safety.${row.kind}.lift`,
      entityType: 'member_safety_control',
      entityId: controlId,
      campaignId,
      detail: 'member lifted their own safety control (subject deliberately not recorded)',
    });
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private async logMute(
    campaignId: number,
    controlId: number,
    user: RequestUser,
    role: Role,
    flavour: 'sender' | 'thread',
  ): Promise<void> {
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'safety.mute.create',
      entityType: 'member_safety_control',
      entityId: controlId,
      campaignId,
      detail: `member muted a ${flavour} (subject deliberately not recorded)`,
    });
  }

  private async findLive(
    kind: SafetyControlKind,
    ownerUserId: string,
    match: {
      targetUserId?: string;
      campaignId?: number;
      threadEntityType?: string;
      threadEntityId?: number;
    },
  ): Promise<typeof memberSafetyControls.$inferSelect | null> {
    const conds = [
      eq(memberSafetyControls.ownerUserId, ownerUserId),
      eq(memberSafetyControls.kind, kind),
      isNull(memberSafetyControls.liftedAt),
    ];
    if (match.targetUserId !== undefined) conds.push(eq(memberSafetyControls.targetUserId, match.targetUserId));
    if (match.campaignId !== undefined) conds.push(eq(memberSafetyControls.campaignId, match.campaignId));
    if (match.threadEntityType !== undefined) {
      conds.push(eq(memberSafetyControls.threadEntityType, match.threadEntityType));
    }
    if (match.threadEntityId !== undefined) {
      conds.push(eq(memberSafetyControls.threadEntityId, match.threadEntityId));
    }
    const [row] = await this.db.select().from(memberSafetyControls).where(and(...conds)!).limit(1);
    return row ?? null;
  }

  /**
   * You may only block/mute somebody you actually share this campaign with. Without
   * that check the endpoint would accept any id and become a cheap probe for which
   * account ids exist. The 400 wording names membership rather than existence for the
   * same reason.
   */
  private async requireCampaignMemberName(campaignId: number, targetUserId: string): Promise<string> {
    const name = await this.lookupMemberName(campaignId, targetUserId);
    if (name == null) {
      throw new BadRequestException('You can only block or mute a member of this campaign.');
    }
    return name;
  }

  private async lookupMemberName(campaignId: number, userId: string): Promise<string | null> {
    // DEV_AUTH synthetic identities have no users/campaign_members rows; accept them by
    // their header name, exactly as NotesService.lookupMember does (non-production path).
    if (userId.startsWith('dev:')) return userId.slice(4) || userId;
    const numeric = Number(userId);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    const [row] = await this.db
      .select({ displayName: users.displayName, username: users.username })
      .from(campaignMembers)
      .innerJoin(users, eq(campaignMembers.userId, users.id))
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, numeric))!)
      .limit(1);
    if (!row) return null;
    return row.displayName || row.username || String(numeric);
  }

  /** Display labels for the caller's own list. Resolved at read time, never stored. */
  private async resolveNames(userIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const numericIds: number[] = [];
    for (const id of new Set(userIds)) {
      if (id.startsWith('dev:')) {
        out.set(id, id.slice(4) || id);
        continue;
      }
      const numeric = Number(id);
      if (Number.isInteger(numeric) && numeric > 0) numericIds.push(numeric);
    }
    if (numericIds.length > 0) {
      const rows = await this.db
        .select({ id: users.id, displayName: users.displayName, username: users.username })
        .from(users)
        .where(inArray(users.id, numericIds));
      for (const row of rows) {
        out.set(String(row.id), row.displayName || row.username || String(row.id));
      }
    }
    return out;
  }

  private toDomain(row: typeof memberSafetyControls.$inferSelect, targetName: string): SafetyControl {
    return {
      id: row.id,
      kind: row.kind as SafetyControlKind,
      campaignId: row.campaignId,
      ownerUserId: row.ownerUserId,
      targetUserId: row.targetUserId,
      targetName,
      threadEntityType: (row.threadEntityType as EntityType | null) ?? null,
      threadEntityId: row.threadEntityId,
      reason: row.reason,
      createdAt: row.createdAt,
    };
  }
}
