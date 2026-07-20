import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiTokenCreate } from '@campfire/schema';
import type { ApiToken, ApiTokenCreated, TokenScope, WriteScope } from '@campfire/schema';
import { DB, type DrizzleDb } from '../../db/db.module';
import { apiTokens, users } from '../../db/schema';
import { nowIso } from '../../common/time';
import { generateApiToken, hashApiToken, apiTokenPrefix } from '../../common/crypto';
import { hasServerAdminPower, minRole, minWriteScope, type RequestUser, type TokenContext } from '../../common/user.types';
import { RoleResolver } from '../membership/role-resolver.service';

type ApiTokenCreateInput = z.infer<typeof ApiTokenCreate>;

/** Shape shared by AuthTokenRequest (headless bootstrap) and AdminTokenCreate (admin provisioning) — `tokenName` rather than `name`, `scope` optional (defaults to least-privilege 'viewer'). */
export interface MintForInput {
  tokenName: string;
  scope?: TokenScope;
  writeScope?: WriteScope;
  campaignId?: number | null;
  adminEnabled?: boolean;
}

/** Least-privilege default when a mint request omits `scope` — matches ApiToken.scope semantics (caps effective role). */
const DEFAULT_TOKEN_SCOPE: TokenScope = 'viewer';

/**
 * Back-compat default when a mint request omits `writeScope`: 'direct' — the
 * token writes exactly as pre-#158 tokens always did. (Least privilege for the
 * WRITE dimension would be 'none', but defaulting there would silently break
 * every existing integration/UI flow that mints a token and expects it to write;
 * operators opt INTO 'propose'/'none' explicitly.)
 */
const DEFAULT_WRITE_SCOPE: WriteScope = 'direct';

/** Throttle lastUsedAt writes to at most once per hour per token. */
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

function toDomain(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    scope: row.scope as ApiToken['scope'],
    writeScope: row.writeScope as ApiToken['writeScope'],
    campaignId: row.campaignId,
    adminEnabled: !!row.adminEnabled,
    tokenPrefix: row.tokenPrefix,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ResolvedToken {
  user: RequestUser;
  tokenContext: TokenContext;
}

@Injectable()
export class TokensService {
  constructor(
    @Inject(DB) private readonly db: DrizzleDb,
    private readonly roleResolver: RoleResolver,
  ) {}

  async listOwn(userId: number): Promise<ApiToken[]> {
    const rows = await this.db.select().from(apiTokens).where(eq(apiTokens.userId, userId));
    return rows.map(toDomain);
  }

  /**
   * `caller` (the authenticated RequestUser, distinct from `userId` — the
   * numeric id the new token will be owned by, always the caller's own per
   * the controller) must have a real BASE effective role — membership row or
   * devRole, never a token's own campaignId cap — on `input.campaignId`
   * when it's non-null. Without this, a user with no relationship to a
   * campaign could mint a token scoped to it and use that token's mere
   * existence to read the campaign's metadata back out (GET /campaigns /
   * MCP list_campaigns via accessibleCampaignIds trusting the token). 403
   * otherwise.
   *
   * `input.adminEnabled` (whether the new token may exercise SERVER-admin
   * power — see hasServerAdminPower()) is only ever honored when `caller`
   * CURRENTLY holds real server-admin power (hasServerAdminPower(caller)):
   * a non-admin, or an admin acting through an already-capped token, cannot
   * mint themselves (or anyone) a more-privileged admin-enabled token —
   * otherwise the cap would be trivially bypassable by re-minting. This is
   * THE authorization check for `adminEnabled` on the self-service path
   * (POST /tokens, where `caller` is the authenticated request's own user).
   * mintFor() below additionally applies its own target-must-be-admin rule
   * before ever passing `adminEnabled: true` in here, since its `caller` arg
   * (used for the campaign-access check, per its own contract) is not
   * necessarily the actor whose privilege should gate `adminEnabled`. Any
   * unauthorized request for adminEnabled:true is silently downgraded to
   * false rather than rejected outright, matching the existing
   * least-privilege default behavior for an omitted `scope`.
   *
   * Issue #41 (privilege escalation, same class as the adminEnabled cap
   * above): when `caller` is itself authenticated via a PAT
   * (caller.tokenContext set), the NEW token must never be broader than the
   * CALLING token — otherwise a viewer-scoped "read-only" PAT handed to an
   * AI agent could simply mint itself a sibling dm-scoped PAT (both capped
   * only by the owner's membership role, which for a DM member allows 'dm')
   * and escalate. Two dimensions are capped here:
   *  - `scope`: silently downgraded to min(requested, calling token's scope)
   *    — same silent-downgrade convention as adminEnabled above, and the
   *    stored scope then participates in RoleResolver's use-time
   *    min(scope, membership role) as usual.
   *  - `campaignId`: a campaign-bound calling token can only mint tokens
   *    bound to that SAME campaign — an explicit request for a different
   *    campaign is 403 (mirroring effectiveRole(), which would resolve null
   *    there), and an unbound request (campaignId omitted/null, i.e. "all my
   *    campaigns") is silently narrowed to the calling token's campaign.
   * Session-cookie callers have no tokenContext and are unaffected; the
   * membership-based campaign-access check below applies to everyone as
   * before.
   */
  async create(userId: number, input: ApiTokenCreateInput, caller: RequestUser): Promise<ApiTokenCreated> {
    let scope = input.scope;
    // Back-compat default 'direct'. Capped below to the calling token so a
    // propose-only / read-only PAT can never mint a broader-write sibling (the
    // exact escalation the writeScope cap exists to prevent — mirrors the scope
    // and adminEnabled caps).
    let writeScope: WriteScope = input.writeScope ?? DEFAULT_WRITE_SCOPE;
    let campaignId = input.campaignId ?? null;

    const callingToken = caller.tokenContext;
    if (callingToken) {
      scope = minRole(scope, callingToken.scope);
      writeScope = minWriteScope(writeScope, callingToken.writeScope);
      if (callingToken.campaignId !== null) {
        if (campaignId !== null && campaignId !== callingToken.campaignId) {
          throw new ForbiddenException('You do not have access to this campaign');
        }
        campaignId = callingToken.campaignId;
      }
    }

    if (campaignId != null) {
      const base = await this.roleResolver.baseEffectiveRole(caller, campaignId);
      if (!base) {
        throw new ForbiddenException('You do not have access to this campaign');
      }
    }

    const adminEnabled = input.adminEnabled === true && hasServerAdminPower(caller);

    const raw = generateApiToken();
    const ts = nowIso();
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        userId,
        name: input.name,
        scope,
        writeScope,
        campaignId,
        adminEnabled,
        tokenHash: hashApiToken(raw),
        tokenPrefix: apiTokenPrefix(raw),
        lastUsedAt: null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    return { token: raw, apiToken: toDomain(row) };
  }

  /**
   * Shared entry point for both mint-a-PAT-in-one-call flows:
   *  - AuthController.token() (POST /auth/token, @Public): `owner` and `requester`
   *    are the SAME just-credential-verified user — access is checked against
   *    their own campaign membership, identical to the self-service POST /tokens,
   *    and `adminEnabled:true` requires that user to themselves currently be a
   *    server admin (fresh credential check — no tokenContext exists yet on this
   *    path, so hasServerAdminPower() reduces to a plain serverRole check).
   *  - UsersController.mintToken() (POST /users/:id/tokens, server-admin only):
   *    `owner` is the target user being provisioned for — passed to create() as
   *    `caller` too, so scope/campaignId are validated against THAT user's
   *    access, never the admin's, exactly as before this fix. `requester` is
   *    the REAL calling admin, passed separately (defaults to `owner` for the
   *    headless-bootstrap case above where there is no separate actor) purely
   *    to decide `adminEnabled`: honored only when `requester` currently holds
   *    real server-admin power AND the TARGET (`owner`) is themselves a server
   *    admin — minting an admin-capable token for a non-admin target would let
   *    that user exercise power their own serverRole doesn't carry, defeating
   *    hasServerAdminPower()'s premise that the underlying user must already
   *    be serverRole==='admin'. Resolved to a plain boolean here (not left for
   *    create() to re-derive from `caller`=owner) since owner's own admin
   *    power is irrelevant to whether THIS request is authorized to grant it.
   * Applies the least-privilege 'viewer' default when scope is omitted.
   */
  async mintFor(owner: RequestUser, ownerId: number, input: MintForInput, requester: RequestUser = owner): Promise<ApiTokenCreated> {
    const adminEnabled = input.adminEnabled === true && owner.serverRole === 'admin' && hasServerAdminPower(requester);
    return this.create(
      ownerId,
      {
        name: input.tokenName,
        scope: input.scope ?? DEFAULT_TOKEN_SCOPE,
        writeScope: input.writeScope ?? DEFAULT_WRITE_SCOPE,
        campaignId: input.campaignId ?? null,
        adminEnabled,
      },
      owner,
    );
  }

  async remove(userId: number, id: number): Promise<void> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Token ${id} not found`);
    await this.db.delete(apiTokens).where(eq(apiTokens.id, id));
  }

  /**
   * Revokes EVERY PAT owned by `userId` in one shot. Admin lifecycle only
   * (DELETE /users/:id/tokens — compromise response: "cut off everything this
   * account's leaked tokens can do"), never exposed self-service. Returns the
   * number of tokens revoked so the caller can report it. Idempotent — zero
   * tokens is not an error.
   */
  async removeAllFor(userId: number): Promise<number> {
    const rows = await this.db.delete(apiTokens).where(eq(apiTokens.userId, userId)).returning();
    return rows.length;
  }

  /**
   * Called from SessionAuthGuard. Looks up a raw Bearer token by its sha256
   * hash; if found (and the owning user is not disabled), returns a
   * RequestUser resolved from the OWNING user plus a TokenContext capturing
   * the token's scope cap. Updates lastUsedAt, throttled to 1/hour.
   */
  async resolveByRawToken(rawToken: string): Promise<ResolvedToken | null> {
    const tokenHash = hashApiToken(rawToken);
    const [row] = await this.db.select().from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash)).limit(1);
    if (!row) return null;

    const [owner] = await this.db.select().from(users).where(eq(users.id, row.userId)).limit(1);
    if (!owner || owner.disabled) return null;

    const now = Date.now();
    const lastUsed = row.lastUsedAt ? new Date(row.lastUsedAt).getTime() : 0;
    if (now - lastUsed > LAST_USED_THROTTLE_MS) {
      await this.db.update(apiTokens).set({ lastUsedAt: new Date(now).toISOString() }).where(eq(apiTokens.id, row.id));
    }

    const user: RequestUser = {
      id: String(owner.id),
      name: owner.displayName || owner.username,
      serverRole: owner.serverRole as RequestUser['serverRole'],
    };
    const tokenContext: TokenContext = {
      tokenId: row.id,
      name: row.name,
      scope: row.scope as TokenContext['scope'],
      writeScope: row.writeScope as TokenContext['writeScope'],
      campaignId: row.campaignId,
      adminEnabled: !!row.adminEnabled,
    };
    return { user, tokenContext };
  }

  /** Convenience guard for controllers: 403 if `id` doesn't belong to `userId`. */
  async assertOwner(userId: number, id: number): Promise<void> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .limit(1);
    if (!row) throw new ForbiddenException('Not your token');
  }
}
