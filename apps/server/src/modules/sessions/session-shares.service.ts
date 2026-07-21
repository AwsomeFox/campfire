import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Role, SessionShare, SessionShareCreated, SharedRecap } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { sessionShares, sessions, campaigns } from '../../db/schema';
import { nowIso } from '../../common/time';
import { notDeleted } from '../../common/soft-delete';
import { generateShareToken, hashShareToken, shareTokenPrefix, looksLikeShareToken } from '../../common/crypto';
import { AuditService } from '../audit/audit.service';
import { auditActor } from '../../common/user.types';
import type { RequestUser } from '../../common/user.types';

function toDomain(row: typeof sessionShares.$inferSelect): SessionShare {
  return {
    id: row.id,
    sessionId: row.sessionId,
    campaignId: row.campaignId,
    createdBy: row.createdBy,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Read-only recap share links: DM-minted capability URLs (`/share/<token>`)
 * that let anyone with the link read ONE session recap, no account required.
 *
 * Security model mirrors PATs (see tokens module / common/crypto.ts):
 *  - tokens are 24 random bytes (`cf_share_<48 hex>`, 192 bits — unguessable)
 *  - the DB stores sha256(token) only; the raw token is returned once at
 *    creation, so a DB leak never exposes live links
 *  - revocation = row deletion; the public resolver joins through to the live
 *    session row, so deleting the session also kills its links
 *  - the public endpoint is rate-limited per IP (see throttle.constants.ts)
 */
@Injectable()
export class SessionSharesService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly audit: AuditService,
  ) {}

  async listForSession(sessionId: number): Promise<SessionShare[]> {
    const rows = await this.db
      .select()
      .from(sessionShares)
      .where(eq(sessionShares.sessionId, sessionId))
      .orderBy(desc(sessionShares.id));
    return rows.map(toDomain);
  }

  async create(session: typeof sessions.$inferSelect, user: RequestUser, role: Role): Promise<SessionShareCreated> {
    const token = generateShareToken();
    const ts = nowIso();
    const [row] = await this.db
      .insert(sessionShares)
      .values({
        sessionId: session.id,
        campaignId: session.campaignId,
        createdBy: auditActor(user),
        tokenHash: hashShareToken(token),
        tokenPrefix: shareTokenPrefix(token),
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();

    await this.audit.log({
      actor: auditActor(user),
      actorRole: role,
      action: 'session.share.create',
      entityType: 'session',
      entityId: session.id,
      campaignId: session.campaignId,
      detail: row.tokenPrefix,
    });
    return { token, share: toDomain(row) };
  }

  /** Revoke (delete) a share link. 404 if it doesn't exist or belongs to a different session. */
  async revoke(shareId: number, session: typeof sessions.$inferSelect, user: RequestUser, role: Role): Promise<void> {
    const [row] = await this.db.select().from(sessionShares).where(eq(sessionShares.id, shareId)).limit(1);
    if (!row || row.sessionId !== session.id) {
      throw new NotFoundException(`Share link ${shareId} not found for this session`);
    }
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

  /**
   * Public (unauthenticated) token -> recap resolution. Uniform 404 for every
   * failure mode (malformed token, unknown/revoked token, deleted session) so
   * the response never distinguishes "never existed" from "revoked".
   */
  async resolveSharedRecap(rawToken: string): Promise<SharedRecap> {
    if (!looksLikeShareToken(rawToken)) {
      throw new NotFoundException('Share link not found or revoked');
    }
    const [row] = await this.db
      .select({
        campaignName: campaigns.name,
        sessionNumber: sessions.number,
        title: sessions.title,
        playedAt: sessions.playedAt,
        recap: sessions.recap,
      })
      .from(sessionShares)
      .innerJoin(sessions, eq(sessionShares.sessionId, sessions.id))
      .innerJoin(campaigns, eq(sessionShares.campaignId, campaigns.id))
      // A trashed session or campaign (soft-deleted, #116) must not resolve its public
      // recap — the share stays dormant (404) until the row is restored.
      .where(and(eq(sessionShares.tokenHash, hashShareToken(rawToken)), notDeleted(sessions.deletedAt), notDeleted(campaigns.deletedAt)))
      .limit(1);
    if (!row) {
      throw new NotFoundException('Share link not found or revoked');
    }
    return row;
  }
}
