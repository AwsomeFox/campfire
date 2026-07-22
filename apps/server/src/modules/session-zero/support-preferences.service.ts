import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';
import type { z } from 'zod';
import { ParticipantSupportPreferenceUpsert } from '@campfire/schema';
import type {
  AiSupportPreference,
  FacilitatorSupportSummary,
  ParticipantSupportPreference,
  Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { participantSupportPreferences } from '../../db/schema';
import { nowIso } from '../../common/time';
import { AuditService } from '../audit/audit.service';
import { auditActor, type RequestUser } from '../../common/user.types';

type UpsertInput = z.infer<typeof ParticipantSupportPreferenceUpsert>;

function toDomain(row: typeof participantSupportPreferences.$inferSelect): ParticipantSupportPreference {
  return {
    id: row.id,
    campaignId: row.campaignId,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerName,
    supportText: row.supportText,
    visibility: row.visibility as ParticipantSupportPreference['visibility'],
    aiUseConsent: row.aiUseConsent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Privacy boundary for participant-owned practical access supports (issue #877).
 * Human reads and model reads are deliberately different methods so a caller
 * cannot accidentally treat facilitator visibility as model consent.
 */
@Injectable()
export class SupportPreferencesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async getOwn(campaignId: number, ownerUserId: string): Promise<ParticipantSupportPreference | null> {
    const [row] = await this.db
      .select()
      .from(participantSupportPreferences)
      .where(
        and(
          eq(participantSupportPreferences.campaignId, campaignId),
          eq(participantSupportPreferences.ownerUserId, ownerUserId),
        ),
      )
      .limit(1);
    return row ? toDomain(row) : null;
  }

  /** Table members see table-shared rows plus their own; facilitators see every row. */
  async listForHuman(campaignId: number, user: RequestUser, role: Role): Promise<ParticipantSupportPreference[]> {
    const visibility = role === 'dm'
      ? eq(participantSupportPreferences.campaignId, campaignId)
      : and(
          eq(participantSupportPreferences.campaignId, campaignId),
          or(
            eq(participantSupportPreferences.visibility, 'table'),
            eq(participantSupportPreferences.ownerUserId, user.id),
          ),
        );
    const rows = await this.db
      .select()
      .from(participantSupportPreferences)
      .where(visibility);
    return rows
      .map(toDomain)
      .sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.id - b.id);
  }

  /** DM prep/live view. The controller enforces the DM role before calling this. */
  async facilitatorSummary(campaignId: number): Promise<FacilitatorSupportSummary> {
    const rows = await this.db
      .select()
      .from(participantSupportPreferences)
      .where(eq(participantSupportPreferences.campaignId, campaignId));
    return {
      campaignId,
      entries: rows.map(toDomain).sort((a, b) => a.ownerName.localeCompare(b.ownerName) || a.id - b.id),
    };
  }

  /**
   * The only model-facing read. It filters solely on explicit AI consent and
   * intentionally does not accept a role—DM/facilitator authority cannot widen it.
   * Every call hits the database, so consent revocation takes effect immediately.
   */
  async listForAi(campaignId: number): Promise<AiSupportPreference[]> {
    const rows = await this.db
      .select()
      .from(participantSupportPreferences)
      .where(
        and(
          eq(participantSupportPreferences.campaignId, campaignId),
          eq(participantSupportPreferences.aiUseConsent, true),
        ),
      );
    return rows
      .map((row) => ({
        participantName: row.ownerName || 'Participant',
        supportText: row.supportText,
        visibility: row.visibility as AiSupportPreference['visibility'],
        aiUseConsent: true as const,
      }))
      .sort((a, b) => a.participantName.localeCompare(b.participantName));
  }

  /**
   * Model-facing read for narration broadcast to the whole table. Consent alone is
   * insufficient here: facilitator-only text must never influence public output.
   */
  async listForPublicAiNarration(campaignId: number): Promise<AiSupportPreference[]> {
    const rows = await this.db
      .select()
      .from(participantSupportPreferences)
      .where(
        and(
          eq(participantSupportPreferences.campaignId, campaignId),
          eq(participantSupportPreferences.aiUseConsent, true),
          eq(participantSupportPreferences.visibility, 'table'),
        ),
      );
    return rows
      .map((row) => ({
        participantName: row.ownerName || 'Participant',
        supportText: row.supportText,
        visibility: 'table' as const,
        aiUseConsent: true as const,
      }))
      .sort((a, b) => a.participantName.localeCompare(b.participantName));
  }

  async upsert(
    campaignId: number,
    input: UpsertInput,
    user: RequestUser,
    role: Role,
  ): Promise<ParticipantSupportPreference> {
    const ts = nowIso();
    const ownerName = (user.name || user.id).slice(0, 120);
    const [row] = await this.db
      .insert(participantSupportPreferences)
      .values({
        campaignId,
        ownerUserId: user.id,
        ownerName,
        supportText: input.supportText,
        visibility: input.visibility,
        aiUseConsent: input.aiUseConsent,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: [participantSupportPreferences.campaignId, participantSupportPreferences.ownerUserId],
        set: {
          ownerName,
          supportText: input.supportText,
          visibility: input.visibility,
          aiUseConsent: input.aiUseConsent,
          updatedAt: ts,
        },
      })
      .returning();

    // Never include supportText in audit detail or log messages.
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'support_preference.upsert',
      entityType: 'support_preference',
      entityId: row.id,
      campaignId,
      detail: JSON.stringify({ visibility: input.visibility, aiUseConsent: input.aiUseConsent }),
    });
    return toDomain(row);
  }

  async removeOwn(campaignId: number, user: RequestUser, role: Role): Promise<void> {
    const existing = await this.getOwn(campaignId, user.id);
    if (!existing) throw new NotFoundException('Support preference not found');
    await this.db
      .delete(participantSupportPreferences)
      .where(
        and(
          eq(participantSupportPreferences.campaignId, campaignId),
          eq(participantSupportPreferences.ownerUserId, user.id),
        ),
      );
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'support_preference.delete',
      entityType: 'support_preference',
      entityId: existing.id,
      campaignId,
    });
  }
}
