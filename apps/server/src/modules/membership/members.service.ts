import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { MemberCreate, MemberUpdate } from '@campfire/schema';
import type { CampaignMember } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaignMembers, campaigns, users, characters, participantSupportPreferences } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CampaignEventsService } from '../events/campaign-events.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

type MemberCreateInput = z.infer<typeof MemberCreate>;
type MemberUpdateInput = z.infer<typeof MemberUpdate>;
type SyncDb = DrizzleDb | Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * SQLITE_CONSTRAINT_* on a unique-index race (issue #819 exclusive character seat).
 * Mirrors the combatants / rules helpers — better-sqlite3 surfaces these codes on
 * a constraint violation; we only care about UNIQUE here.
 */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/** Outcome of resolving an exclusive character seat assignment inside a tx. */
type CharacterSeatResolution = {
  characterName: string;
  /** Prior seat holder user id when a confirmed transfer cleared their link. */
  previousHolderUserId: number | null;
  transferred: boolean;
};

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
        disabled: users.disabled,
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
      disabled: r.disabled ?? true,
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

  /** Count only DM seats whose account can actually authenticate (#849). */
  private usableDmCountTx(tx: SyncDb, campaignId: number): number {
    return tx
      .select({ value: count() })
      .from(campaignMembers)
      .innerJoin(users, eq(campaignMembers.userId, users.id))
      .where(
        and(
          eq(campaignMembers.campaignId, campaignId),
          eq(campaignMembers.role, 'dm'),
          eq(users.disabled, false),
        ),
      )
      .get()?.value ?? 0;
  }

  private assignableUserTx(tx: SyncDb, userId: number): typeof users.$inferSelect {
    const user = tx.select().from(users).where(eq(users.id, userId)).limit(1).get();
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    if (user.disabled) {
      throw new BadRequestException(`User ${userId} is disabled and cannot be assigned to a campaign`);
    }
    return user;
  }

  /** Auto-inserts the creator as 'dm' when a campaign is created (skipped for dev:* users). */
  async addCreatorAsDm(campaignId: number, userId: number): Promise<void> {
    const ts = nowIso();
    this.db.transaction((tx) => {
      this.assignableUserTx(tx, userId);
      tx.insert(campaignMembers)
        .values({ campaignId, userId, role: 'dm', characterId: null, createdAt: ts, updatedAt: ts })
        .onConflictDoNothing()
        .run();
    });
  }

  /**
   * Issue #725: the transaction-aware variant of addCreatorAsDm, for callers that
   * must commit the dm membership IN THE SAME transaction as the rest of their
   * writes (currently CampaignsService.importCampaign — so the importer's access
   * and every imported row commit atomically; a failure here rolls the whole
   * import back instead of stranding an inaccessible campaign). Runs the SAME
   * assignableUserTx validation (missing/disabled user throws) so the import
   * cannot silently grant a disabled account a dm seat. `ts` is supplied by the
   * caller so every row in the import shares one timestamp.
   */
  addCreatorAsDmTx(tx: SyncDb, campaignId: number, userId: number, ts: string): void {
    this.assignableUserTx(tx, userId);
    tx.insert(campaignMembers)
      .values({ campaignId, userId, role: 'dm', characterId: null, createdAt: ts, updatedAt: ts })
      .onConflictDoNothing()
      .run();
  }

  /**
   * characterId is an FK-shaped field that previously accepted any integer with no
   * existence/campaign check — a nonexistent id, or another campaign's character id,
   * would silently pass through and get denormalized-joined against on listForCampaign.
   * Returns the character row when present so callers can reuse name/owner without a
   * second round-trip (issue #819 exclusive-seat checks).
   */
  private validateCharacterRefTx(
    tx: SyncDb,
    characterId: number | null | undefined,
    campaignId: number,
  ): { id: number; name: string; ownerUserId: string | null } | null {
    if (characterId == null) return null;
    const row = tx
      .select({ id: characters.id, name: characters.name, ownerUserId: characters.ownerUserId })
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.campaignId, campaignId)))
      .limit(1)
      .get();
    if (!row) throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);
    return row;
  }

  /**
   * Issue #819 — exclusive character seat.
   *
   * A character may be linked from at most one campaign_members row. Linking it to
   * a different member (or claiming it while another member owns it via
   * characters.ownerUserId) requires `confirmTransfer: true`. Without confirmation
   * the write is rejected with 409 CHARACTER_SEAT_TAKEN so the UI can ask
   * "Transfer Aria from Alice to Bob?" before committing.
   *
   * On a confirmed transfer, the previous seat's characterId is cleared in the
   * same transaction as the new link (and ownership sync), so the unique index
   * `idx_campaign_members_character` and the membership pointer stay consistent.
   */
  private claimExclusiveCharacterSeatTx(
    tx: SyncDb,
    campaignId: number,
    characterId: number,
    assigneeUserId: number,
    confirmTransfer: boolean | undefined,
    opts?: { excludeMemberId?: number },
  ): CharacterSeatResolution {
    const character = this.validateCharacterRefTx(tx, characterId, campaignId);
    // validateCharacterRefTx only returns null when characterId is null — unreachable here.
    if (!character) throw new BadRequestException(`characterId ${characterId} does not exist in this campaign`);

    const seat = tx
      .select({
        id: campaignMembers.id,
        userId: campaignMembers.userId,
      })
      .from(campaignMembers)
      .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.characterId, characterId)))
      .limit(1)
      .get();

    // Same seat / same assignee — idempotent re-link, no transfer.
    if (seat && (seat.id === opts?.excludeMemberId || seat.userId === assigneeUserId)) {
      return { characterName: character.name, previousHolderUserId: null, transferred: false };
    }

    let holderUserId: number | null = seat?.userId ?? null;
    const holderMemberId: number | null = seat?.id ?? null;

    // Ownership-only holder: character.ownerUserId points at another principal while
    // no seat links this character. Overwriting that ownership also needs confirmation.
    if (holderUserId == null && character.ownerUserId != null && character.ownerUserId !== String(assigneeUserId)) {
      const ownerNumeric = Number(character.ownerUserId);
      holderUserId = Number.isInteger(ownerNumeric) && ownerNumeric > 0 ? ownerNumeric : null;
      if (!confirmTransfer) {
        throw new ConflictException({
          code: 'CHARACTER_SEAT_TAKEN',
          message:
            `Character "${character.name}" is already owned by another member — ` +
            'resend with confirmTransfer: true to transfer the exclusive seat and ownership',
          characterId,
          holderMemberId: null,
          holderUserId,
        });
      }
      return {
        characterName: character.name,
        previousHolderUserId: holderUserId,
        transferred: true,
      };
    }

    if (holderUserId != null && holderUserId !== assigneeUserId) {
      if (!confirmTransfer) {
        throw new ConflictException({
          code: 'CHARACTER_SEAT_TAKEN',
          message:
            `Character "${character.name}" is already assigned to another member — ` +
            'resend with confirmTransfer: true to transfer the exclusive seat and ownership',
          characterId,
          holderMemberId,
          holderUserId,
        });
      }
      if (holderMemberId != null) {
        tx
          .update(campaignMembers)
          .set({ characterId: null, updatedAt: nowIso() })
          .where(and(eq(campaignMembers.id, holderMemberId), eq(campaignMembers.campaignId, campaignId)))
          .run();
      }
      return {
        characterName: character.name,
        previousHolderUserId: holderUserId,
        transferred: true,
      };
    }

    return { characterName: character.name, previousHolderUserId: null, transferred: false };
  }

  /**
   * Issue #32: linking a member to a character grants that player edit rights by syncing
   * characters.ownerUserId (the string form of users.id — see UserIdRef in @campfire/schema;
   * campaignMembers.userId is the raw integer) instead of requiring the DM to also PATCH
   * the character's ownerUserId by hand. Unlinking (or re-linking to another character)
   * clears ownership only when the character is still owned by this member, so an explicit
   * DM reassignment via PATCH /characters/:id is never clobbered.
   *
   * Issue #819: the *assignment* of nextCharacterId is gated by
   * {@link claimExclusiveCharacterSeatTx} so this sync never silently steals a seat.
   */
  private syncCharacterOwnershipTx(
    tx: SyncDb,
    userId: number,
    previousCharacterId: number | null,
    nextCharacterId: number | null,
    updatedAt: string,
  ): void {
    if (previousCharacterId === nextCharacterId) return;
    const ownerUserId = String(userId);
    if (previousCharacterId != null) {
      tx
        .update(characters)
        .set({ ownerUserId: null, updatedAt })
        .where(and(eq(characters.id, previousCharacterId), eq(characters.ownerUserId, ownerUserId)))
        .run();
    }
    if (nextCharacterId != null) {
      tx
        .update(characters)
        .set({ ownerUserId, updatedAt })
        .where(eq(characters.id, nextCharacterId))
        .run();
    }
  }

  /** Best-effort notify + SSE after a character seat/ownership change (issue #819). */
  private async publishCharacterSeatChange(
    campaignId: number,
    characterId: number,
    characterName: string,
    actor: RequestUser,
    assigneeUserId: number,
    previousHolderUserId: number | null,
    transferred: boolean,
  ): Promise<void> {
    // Permission-bearing sheet change — clients refetch via character.updated.
    this.events.emit({
      type: 'character.updated',
      campaignId,
      characterId,
      userId: actor.id,
    });

    if (transferred && previousHolderUserId != null) {
      await this.notifications.notifyUser(previousHolderUserId, campaignId, actor, {
        type: 'character_reassigned',
        title: `${characterName} was transferred to another player`,
        body: 'You no longer own this character sheet or its encounter controls.',
        entityType: 'character',
        entityId: characterId,
        actorName: actor.name,
      });
    }
    await this.notifications.notifyUser(assigneeUserId, campaignId, actor, {
      type: 'character_reassigned',
      title: transferred
        ? `${characterName} was transferred to you`
        : `${characterName} was linked to you`,
      body: 'You can edit this character sheet and use its encounter controls.',
      entityType: 'character',
      entityId: characterId,
      actorName: actor.name,
    });
  }

  async create(campaignId: number, input: MemberCreateInput, actor: RequestUser): Promise<CampaignMember> {
    const ts = nowIso();
    let seatResolution: CharacterSeatResolution | null = null;
    let row: typeof campaignMembers.$inferSelect;
    try {
      row = this.db.transaction((tx) => {
        this.assignableUserTx(tx, input.userId);
        const existing = tx
          .select({ id: campaignMembers.id })
          .from(campaignMembers)
          .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, input.userId)))
          .limit(1)
          .get();
        if (existing) throw new ConflictException('User is already a member of this campaign');

        if (input.characterId != null) {
          seatResolution = this.claimExclusiveCharacterSeatTx(
            tx,
            campaignId,
            input.characterId,
            input.userId,
            input.confirmTransfer,
          );
        } else {
          this.validateCharacterRefTx(tx, input.characterId, campaignId);
        }

        const inserted = tx
          .insert(campaignMembers)
          .values({
            campaignId,
            userId: input.userId,
            role: input.role,
            characterId: input.characterId ?? null,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
          .get();
        this.syncCharacterOwnershipTx(tx, input.userId, null, input.characterId ?? null, ts);
        return inserted;
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && input.characterId != null) {
        throw new ConflictException({
          code: 'CHARACTER_SEAT_TAKEN',
          message:
            `Character ${input.characterId} is already assigned to another member — ` +
            'resend with confirmTransfer: true to transfer the exclusive seat and ownership',
          characterId: input.characterId,
        });
      }
      throw err;
    }

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

    if (input.characterId != null && seatResolution) {
      const resolved: CharacterSeatResolution = seatResolution;
      await this.publishCharacterSeatChange(
        campaignId,
        input.characterId,
        resolved.characterName,
        actor,
        input.userId,
        resolved.previousHolderUserId,
        resolved.transferred,
      );
    }

    const [full] = await this.listForCampaign(campaignId).then((all) => all.filter((m) => m.id === row.id));
    return full;
  }

  async update(campaignId: number, memberId: number, input: MemberUpdateInput, actor: RequestUser): Promise<CampaignMember> {
    const ts = nowIso();
    const update: Partial<typeof campaignMembers.$inferInsert> = { updatedAt: ts };
    if (input.role !== undefined) update.role = input.role;
    if (input.characterId !== undefined) update.characterId = input.characterId;

    // Re-read the member, count usable DMs, validate references, mutate the role,
    // claim/transfer an exclusive character seat, and sync ownership inside one
    // synchronous SQLite transaction. Concurrent REST/MCP/account-lifecycle
    // changes therefore serialize at the same invariant (#654 + #849 + #819).
    let seatResolution: CharacterSeatResolution | null = null;
    let assigneeUserId: number | null = null;
    let previousCharacterId: number | null = null;
    let priorRole: CampaignMember['role'] | null = null;
    try {
      this.db.transaction((tx) => {
        const row = tx
          .select({ member: campaignMembers, disabled: users.disabled })
          .from(campaignMembers)
          .innerJoin(users, eq(campaignMembers.userId, users.id))
          .where(and(eq(campaignMembers.id, memberId), eq(campaignMembers.campaignId, campaignId)))
          .limit(1)
          .get();
        if (!row) throw new NotFoundException(`Member ${memberId} not found`);

        assigneeUserId = row.member.userId;
        previousCharacterId = row.member.characterId;
        priorRole = row.member.role as CampaignMember['role'];

        const promotingDisabledDm = input.role === 'dm' && row.member.role !== 'dm' && row.disabled;
        if (promotingDisabledDm) {
          throw new BadRequestException(`User ${row.member.userId} is disabled and cannot be assigned as dm`);
        }

        const demotingUsableDm =
          input.role !== undefined && input.role !== 'dm' && row.member.role === 'dm' && !row.disabled;
        if (demotingUsableDm && this.usableDmCountTx(tx, campaignId) <= 1) {
          throw new ConflictException('Cannot demote the last dm of this campaign');
        }

        // Preserve the established error precedence: last-DM conflict before an
        // invalid / contested character link in a combined patch (reviewed in #654).
        if (input.characterId != null) {
          seatResolution = this.claimExclusiveCharacterSeatTx(
            tx,
            campaignId,
            input.characterId,
            row.member.userId,
            input.confirmTransfer,
            { excludeMemberId: memberId },
          );
        } else {
          this.validateCharacterRefTx(tx, input.characterId, campaignId);
        }

        tx.update(campaignMembers)
          .set(update)
          .where(and(eq(campaignMembers.id, memberId), eq(campaignMembers.campaignId, campaignId)))
          .run();

        if (input.characterId !== undefined && row.member.characterId !== input.characterId) {
          this.syncCharacterOwnershipTx(tx, row.member.userId, row.member.characterId, input.characterId, ts);
        }
      });
    } catch (err) {
      if (isUniqueConstraintError(err) && input.characterId != null) {
        throw new ConflictException({
          code: 'CHARACTER_SEAT_TAKEN',
          message:
            `Character ${input.characterId} is already assigned to another member — ` +
            'resend with confirmTransfer: true to transfer the exclusive seat and ownership',
          characterId: input.characterId,
        });
      }
      throw err;
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

    if (
      input.characterId != null &&
      seatResolution &&
      assigneeUserId != null &&
      previousCharacterId !== input.characterId
    ) {
      const resolved: CharacterSeatResolution = seatResolution;
      await this.publishCharacterSeatChange(
        campaignId,
        input.characterId,
        resolved.characterName,
        actor,
        assigneeUserId,
        resolved.previousHolderUserId,
        resolved.transferred,
      );
    } else if (
      input.characterId !== undefined &&
      input.characterId !== previousCharacterId &&
      (previousCharacterId != null || input.characterId != null)
    ) {
      // Unlink or self-only reassignment still invalidates permission state.
      const changedId = input.characterId ?? previousCharacterId;
      if (changedId != null) {
        this.events.emit({
          type: 'character.updated',
          campaignId,
          characterId: changedId,
          userId: actor.id,
        });
        if (previousCharacterId != null && input.characterId != null && previousCharacterId !== input.characterId) {
          this.events.emit({
            type: 'character.updated',
            campaignId,
            characterId: previousCharacterId,
            userId: actor.id,
          });
        }
      }
    }

    const all = await this.listForCampaign(campaignId);
    const updated = all.find((m) => m.id === memberId);
    if (!updated) throw new NotFoundException(`Member ${memberId} not found`);

    // Issue #437: publish role changes so the affected member's open browsers can
    // invalidate cached /me memberships immediately (promote → DM nav; demote →
    // drop forbidden controls) without a reload. Character-link-only patches stay quiet.
    if (input.role !== undefined && priorRole != null && updated.role !== priorRole) {
      this.events.emit({
        type: 'membership.updated',
        campaignId,
        userId: String(updated.userId),
        memberId: updated.id,
        role: updated.role,
      });
    }

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
    const existing = this.db.transaction((tx) => {
      const row = tx
        .select({ member: campaignMembers, disabled: users.disabled })
        .from(campaignMembers)
        .innerJoin(users, eq(campaignMembers.userId, users.id))
        .where(and(eq(campaignMembers.id, memberId), eq(campaignMembers.campaignId, campaignId)))
        .limit(1)
        .get();
      if (!row) throw new NotFoundException(`Member ${memberId} not found`);

      if (row.member.role === 'dm' && !row.disabled && this.usableDmCountTx(tx, campaignId) <= 1) {
        throw new ConflictException(
          opts?.selfLeave
            ? 'You are the last dm of this campaign — hand dm off to someone else before leaving'
            : 'Cannot remove the last dm of this campaign',
        );
      }

      tx.delete(campaignMembers)
        .where(and(eq(campaignMembers.id, memberId), eq(campaignMembers.campaignId, campaignId)))
        .run();
      // A support submission is participant-owned, not campaign history. Leaving
      // or removal deletes it immediately, which also revokes future model use.
      tx.delete(participantSupportPreferences)
        .where(
          and(
            eq(participantSupportPreferences.campaignId, campaignId),
            eq(participantSupportPreferences.ownerUserId, String(row.member.userId)),
          ),
        )
        .run();
      tx.update(characters)
        .set({ ownerUserId: null, updatedAt: nowIso() })
        .where(and(eq(characters.campaignId, campaignId), eq(characters.ownerUserId, String(row.member.userId))))
        .run();
      return row.member;
    });

    // Issue #527: the revocation event MUST be emitted whenever the DB delete above
    // succeeded, regardless of whether audit logging throws. If audit failure were
    // allowed to skip the emit, the removed user's open SSE stream would keep flowing
    // (authorization drift persists under partial failure) — the exact bug this issue
    // fixes. So emit first (the delete already committed; a rolled-back remove can no
    // longer happen), then log audit best-effort: an audit row is valuable but not
    // load-bearing for authorization, and a thrown audit insert is caught here so it
    // does not surface as a 500 to the actor who already succeeded in removing the
    // member. (Audit errors are otherwise unexpected — they would indicate a DB issue
    // worth investigating via server logs, which is why this logs rather than swallows
    // silently.)
    this.events.emit({
      type: 'membership.revoked',
      campaignId,
      userId: String(existing.userId),
      memberId,
    });

    try {
      await this.audit.log({
        actor: auditActor(actor),
        actorRole: opts?.selfLeave ? (existing.role as CampaignMember['role']) : 'dm',
        action: opts?.selfLeave ? 'member.leave' : 'member.delete',
        entityType: 'campaign_member',
        entityId: memberId,
        campaignId,
      });
    } catch (err) {
      // Pass the error as the trace arg (not stringified into the message) so
      // Nest's Logger emits the full stack — stringifying drops it and makes a
      // real DB failure hard to diagnose. The message names the member + the
      // consequence (audit-trail gap) so the log line stands on its own; the
      // trace carries the actionable root cause.
      const logger = new Logger(MembersService.name);
      const message = `membership.revoked emitted for memberId=${memberId} but audit log failed — the remove succeeded; this row will be missing from the audit trail.`;
      if (err instanceof Error) logger.error(message, err.stack);
      else logger.error(`${message} Underlying error: ${String(err)}`);
    }
  }
}
