import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type {
  CastSession,
  CastSessionCreate,
  CastSessionCreated,
  CastSessionMutationResult,
  CampaignSummary,
  Encounter,
  EncounterWithCombatants,
  Role,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, castSessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import {
  castTokenPrefix,
  generateCastExitPin,
  generateCastToken,
  hashCastToken,
  hashPassword,
  looksLikeCastToken,
  verifyPassword,
} from '../../common/crypto';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';
import { AuditService } from '../audit/audit.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { EncountersService } from '../encounters/encounters.service';

const CAST_VIEWER_ROLE: Role = 'viewer';
const UNIFORM_NOT_FOUND = 'Cast session not found or expired';
const DUMMY_CAST_TOKEN = `cf_cast_${'0'.repeat(48)}`;

function toDomain(row: typeof castSessions.$inferSelect): CastSession {
  return {
    id: row.id,
    campaignId: row.campaignId,
    label: row.label,
    createdBy: row.createdBy,
    tokenPrefix: row.tokenPrefix,
    expiresAt: row.expiresAt,
    accessCount: row.accessCount,
    firstAccessedAt: row.firstAccessedAt,
    lastAccessedAt: row.lastAccessedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeFutureExpiry(expiresAt: string): string {
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  return new Date(timestamp).toISOString();
}

@Injectable()
export class CastService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly campaignsService: CampaignsService,
    private readonly encountersService: EncountersService,
  ) {}

  async listForCampaign(campaignId: number): Promise<CastSession[]> {
    const ts = nowIso();
    const rows = await this.db
      .select()
      .from(castSessions)
      .where(and(eq(castSessions.campaignId, campaignId), gt(castSessions.expiresAt, ts)))
      .orderBy(desc(castSessions.id));
    return rows.map(toDomain);
  }

  async create(campaignId: number, input: CastSessionCreate, user: RequestUser, role: Role): Promise<CastSessionCreated> {
    const expiresAt = normalizeFutureExpiry(input.expiresAt);
    const token = generateCastToken();
    const exitPin = generateCastExitPin();
    const ts = nowIso();

    const row = this.db.transaction((tx) => {
      const campaign = tx
        .select()
        .from(campaigns)
        .where(and(eq(campaigns.id, campaignId), notDeleted(campaigns.deletedAt)))
        .limit(1)
        .get();
      if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
      if (campaign.status !== 'active') {
        throw new ForbiddenException('Cast sessions require an active campaign');
      }
      return tx
        .insert(castSessions)
        .values({
          campaignId,
          label: input.label,
          createdBy: user.name,
          tokenHash: hashCastToken(token),
          tokenPrefix: castTokenPrefix(token),
          exitPinHash: hashPassword(exitPin),
          expiresAt,
          accessCount: 0,
          firstAccessedAt: null,
          lastAccessedAt: null,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.cast.create',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify({ label: row.label, expiresAt: row.expiresAt, tokenPrefix: row.tokenPrefix }),
    });

    return { token, exitPin, url: `/cast/${campaignId}/${token}`, session: toDomain(row) };
  }

  async revoke(campaignId: number, castSessionId: number, user: RequestUser, role: Role): Promise<void> {
    const [row] = await this.db
      .select()
      .from(castSessions)
      .where(and(eq(castSessions.id, castSessionId), eq(castSessions.campaignId, campaignId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Cast session ${castSessionId} not found for this campaign`);
    await this.db.delete(castSessions).where(eq(castSessions.id, castSessionId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.cast.revoke',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: row.tokenPrefix,
    });
  }

  async revokeAll(campaignId: number, user: RequestUser, role: Role): Promise<CastSessionMutationResult> {
    const deleted = await this.db
      .delete(castSessions)
      .where(eq(castSessions.campaignId, campaignId))
      .returning({ id: castSessions.id });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.cast.revoke_all',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify({ revoked: deleted.length }),
    });
    return { revoked: deleted.length };
  }

  private resolveActive(token: string): typeof castSessions.$inferSelect {
    const tokenToHash = looksLikeCastToken(token) ? token : DUMMY_CAST_TOKEN;
    const row = this.db
      .select()
      .from(castSessions)
      .where(eq(castSessions.tokenHash, hashCastToken(tokenToHash)))
      .limit(1)
      .get();
    const ts = nowIso();
    if (!looksLikeCastToken(token) || !row || row.expiresAt <= ts) {
      throw new NotFoundException(UNIFORM_NOT_FOUND);
    }

    const campaign = this.db
      .select({ status: campaigns.status, deletedAt: campaigns.deletedAt })
      .from(campaigns)
      .where(eq(campaigns.id, row.campaignId))
      .limit(1)
      .get();
    if (!campaign || campaign.deletedAt !== null || campaign.status !== 'active') {
      throw new NotFoundException(UNIFORM_NOT_FOUND);
    }

    this.db
      .update(castSessions)
      .set({
        accessCount: sql`${castSessions.accessCount} + 1`,
        firstAccessedAt: row.firstAccessedAt ?? ts,
        lastAccessedAt: ts,
        updatedAt: ts,
      })
      .where(eq(castSessions.id, row.id))
      .run();
    return { ...row, accessCount: row.accessCount + 1, firstAccessedAt: row.firstAccessedAt ?? ts, lastAccessedAt: ts, updatedAt: ts };
  }

  async summary(token: string): Promise<CampaignSummary> {
    const cast = this.resolveActive(token);
    return this.campaignsService.summary(cast.campaignId, CAST_VIEWER_ROLE);
  }

  async runningEncounters(token: string): Promise<Encounter[]> {
    const cast = this.resolveActive(token);
    return this.encountersService.listForCampaign(cast.campaignId, 'running', CAST_VIEWER_ROLE);
  }

  async encounter(token: string, encounterId: number): Promise<EncounterWithCombatants> {
    const cast = this.resolveActive(token);
    const row = await this.encountersService.getRowOrThrow(encounterId);
    if (row.campaignId !== cast.campaignId) throw new NotFoundException(`Encounter ${encounterId} not found`);
    return this.encountersService.getWithCombatantsOrThrow(encounterId, CAST_VIEWER_ROLE);
  }

  async verifyExitPin(token: string, pin: string): Promise<{ ok: true }> {
    const cast = this.resolveActive(token);
    if (!verifyPassword(pin, cast.exitPinHash)) {
      throw new ForbiddenException('Invalid cast exit PIN');
    }
    return { ok: true };
  }
}
