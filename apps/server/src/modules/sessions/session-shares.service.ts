import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type {
  Role,
  SessionShare,
  SessionShareCreate,
  SessionShareCreated,
  SessionShareMutationResult,
  SessionShareUpdate,
  SharedRecap,
} from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { campaigns, sessionShares, sessions } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { generateShareToken, hashShareToken, shareTokenPrefix, looksLikeShareToken } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

const UNIFORM_NOT_FOUND = 'Share link not found or revoked';
const DUMMY_SHARE_TOKEN = `cf_share_${'0'.repeat(48)}`;

function toDomain(row: typeof sessionShares.$inferSelect): SessionShare {
  return {
    id: row.id,
    sessionId: row.sessionId,
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

function assertFutureExpiry(expiresAt: string | null): void {
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future, or null for a deliberately non-expiring link');
  }
}

function isExtension(previous: string | null, next: string | null | undefined): boolean {
  if (next === undefined || previous === null) return false;
  if (next === null) return true;
  return Date.parse(next) > Date.parse(previous);
}

function expiryLabel(expiresAt: string | null): string {
  return expiresAt === null ? 'never expires' : `expires ${expiresAt}`;
}

/**
 * Read-only recap capability URLs. Raw tokens are returned once and only their
 * SHA-256 hashes are persisted. Every new token carries an explicit expiry
 * decision; member-facing metadata never contains enough material to recreate
 * the URL.
 */
@Injectable()
export class SessionSharesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async getCampaignOrThrow(campaignId: number): Promise<typeof campaigns.$inferSelect> {
    const [campaign] = await this.db
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), notDeleted(campaigns.deletedAt)))
      .limit(1);
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    return campaign;
  }

  /** Active metadata is visible to every campaign member; mutation remains DM-only. */
  async listForSession(sessionId: number): Promise<SessionShare[]> {
    const ts = nowIso();
    const rows = await this.db
      .select()
      .from(sessionShares)
      .where(
        and(
          eq(sessionShares.sessionId, sessionId),
          or(isNull(sessionShares.expiresAt), gt(sessionShares.expiresAt, ts)),
        ),
      )
      .orderBy(desc(sessionShares.id));
    return rows.map(toDomain);
  }

  async create(
    session: typeof sessions.$inferSelect,
    input: SessionShareCreate,
    user: RequestUser,
    role: Role,
  ): Promise<SessionShareCreated> {
    assertFutureExpiry(input.expiresAt);
    const token = generateShareToken();
    const ts = nowIso();
    const row = this.db.transaction((tx) => {
      const campaign = tx.select().from(campaigns).where(eq(campaigns.id, session.campaignId)).limit(1).get();
      if (
        !campaign?.publicRecapSharingEnabled
        || campaign.status !== 'active'
        || campaign.deletedAt !== null
      ) {
        throw new ForbiddenException('Public recap sharing is disabled for this campaign');
      }
      return tx
        .insert(sessionShares)
        .values({
          sessionId: session.id,
          campaignId: session.campaignId,
          label: input.label,
          createdBy: user.name,
          tokenHash: hashShareToken(token),
          tokenPrefix: shareTokenPrefix(token),
          expiresAt: input.expiresAt,
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
      action: 'session.share.create',
      entityType: 'session',
      entityId: session.id,
      campaignId: session.campaignId,
      detail: JSON.stringify({ label: row.label, expiresAt: row.expiresAt, tokenPrefix: row.tokenPrefix }),
    });
    await this.notifications.notifyCampaign(session.campaignId, user, {
      type: 'recap_share_enabled',
      title: `Public sharing enabled for Session ${session.number}`,
      body: `${row.label || 'Unlabelled link'} · ${expiryLabel(row.expiresAt)}`,
      entityType: 'session',
      entityId: session.id,
      actorName: user.name,
    });
    return { token, share: toDomain(row) };
  }

  async update(
    shareId: number,
    session: typeof sessions.$inferSelect,
    input: SessionShareUpdate,
    user: RequestUser,
    role: Role,
  ): Promise<SessionShare> {
    if (input.expiresAt !== undefined) assertFutureExpiry(input.expiresAt);
    const ts = nowIso();
    const { row, extended } = this.db.transaction((tx) => {
      const campaign = tx.select().from(campaigns).where(eq(campaigns.id, session.campaignId)).limit(1).get();
      if (
        !campaign?.publicRecapSharingEnabled
        || campaign.status !== 'active'
        || campaign.deletedAt !== null
      ) {
        throw new ForbiddenException('Public recap sharing is disabled for this campaign');
      }
      const existing = tx
        .select()
        .from(sessionShares)
        .where(
          and(
            eq(sessionShares.id, shareId),
            eq(sessionShares.sessionId, session.id),
            or(isNull(sessionShares.expiresAt), gt(sessionShares.expiresAt, ts)),
          ),
        )
        .limit(1)
        .get();
      if (!existing) throw new NotFoundException(`Share link ${shareId} not found for this session`);
      const updated = tx
        .update(sessionShares)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          updatedAt: ts,
        })
        .where(eq(sessionShares.id, shareId))
        .returning()
        .get();
      return { row: updated, extended: isExtension(existing.expiresAt, input.expiresAt) };
    });

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.share.update',
      entityType: 'session',
      entityId: session.id,
      campaignId: session.campaignId,
      detail: JSON.stringify({ label: row.label, expiresAt: row.expiresAt, tokenPrefix: row.tokenPrefix }),
    });
    if (extended) {
      await this.notifications.notifyCampaign(session.campaignId, user, {
        type: 'recap_share_extended',
        title: `Public sharing extended for Session ${session.number}`,
        body: `${row.label || 'Unlabelled link'} · ${expiryLabel(row.expiresAt)}`,
        entityType: 'session',
        entityId: session.id,
        actorName: user.name,
      });
    }
    return toDomain(row);
  }

  /** Revoke one capability. A mismatched session intentionally looks absent. */
  async revoke(shareId: number, session: typeof sessions.$inferSelect, user: RequestUser, role: Role): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sessionShares)
      .where(and(eq(sessionShares.id, shareId), eq(sessionShares.sessionId, session.id)))
      .limit(1);
    if (!row) throw new NotFoundException(`Share link ${shareId} not found for this session`);
    await this.db.delete(sessionShares).where(eq(sessionShares.id, shareId));
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.share.revoke',
      entityType: 'session',
      entityId: session.id,
      campaignId: session.campaignId,
      detail: row.tokenPrefix,
    });
  }

  async revokeAll(campaignId: number, user: RequestUser, role: Role): Promise<SessionShareMutationResult> {
    await this.getCampaignOrThrow(campaignId);
    const deleted = await this.db.delete(sessionShares).where(eq(sessionShares.campaignId, campaignId)).returning({ id: sessionShares.id });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.share.revoke_all',
      entityType: 'campaign',
      entityId: campaignId,
      campaignId,
      detail: JSON.stringify({ revoked: deleted.length }),
    });
    return { revoked: deleted.length };
  }

  /** Disabling is atomic with revocation, so re-enabling cannot resurrect URLs. */
  async setCampaignPolicy(
    campaign: { id: number; status: string },
    enabled: boolean,
    user: RequestUser,
    role: Role,
  ): Promise<SessionShareMutationResult> {
    if (enabled && campaign.status !== 'active') {
      throw new ForbiddenException('Unarchive the campaign before enabling public recap sharing');
    }
    const ts = nowIso();
    const revoked = this.db.transaction((tx) => {
      const removed = enabled
        ? []
        : tx.delete(sessionShares).where(eq(sessionShares.campaignId, campaign.id)).returning({ id: sessionShares.id }).all();
      tx.update(campaigns)
        .set({ publicRecapSharingEnabled: enabled, updatedAt: ts })
        .where(eq(campaigns.id, campaign.id))
        .run();
      return removed.length;
    });
    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'campaign.share.policy',
      entityType: 'campaign',
      entityId: campaign.id,
      campaignId: campaign.id,
      detail: JSON.stringify({ enabled, revoked }),
    });
    return { revoked };
  }

  /**
   * Public token resolution. Every denial traverses the same indexed lookup and
   * emits the same 404 message. Malformed input uses a fixed dummy token so an
   * attacker cannot distinguish syntax, expiry, policy, archive, or revocation
   * from response semantics (and cannot make hashing cost scale with URL size).
   */
  async resolveSharedRecap(rawToken: string): Promise<SharedRecap> {
    const candidate = looksLikeShareToken(rawToken) ? rawToken : DUMMY_SHARE_TOKEN;
    const ts = nowIso();
    const [row] = await this.db
      .select({
        shareId: sessionShares.id,
        campaignName: campaigns.name,
        sessionNumber: sessions.number,
        title: sessions.title,
        playedAt: sessions.playedAt,
        recap: sessions.recap,
      })
      .from(sessionShares)
      .innerJoin(sessions, eq(sessionShares.sessionId, sessions.id))
      .innerJoin(campaigns, eq(sessionShares.campaignId, campaigns.id))
      .where(
        and(
          eq(sessionShares.tokenHash, hashShareToken(candidate)),
          or(isNull(sessionShares.expiresAt), gt(sessionShares.expiresAt, ts)),
          eq(campaigns.publicRecapSharingEnabled, true),
          eq(campaigns.status, 'active'),
          notDeleted(sessions.deletedAt),
          notDeleted(campaigns.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException(UNIFORM_NOT_FOUND);

    await this.db
      .update(sessionShares)
      .set({
        accessCount: sql`${sessionShares.accessCount} + 1`,
        firstAccessedAt: sql`COALESCE(${sessionShares.firstAccessedAt}, ${ts})`,
        lastAccessedAt: ts,
      })
      .where(eq(sessionShares.id, row.shareId));

    const { shareId: _shareId, ...recap } = row;
    return recap;
  }
}
