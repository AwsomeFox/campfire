import type { Role, ServerRole, WriteScope } from '@campfire/schema';

/**
 * Resolved from either a session cookie (real users) or, when DEV_AUTH=1,
 * legacy x-dev-user/x-dev-role headers (synthetic `dev:<name>` users — keeps
 * all pre-auth e2e tests passing unchanged).
 *
 * `role` is no longer part of this shape — campaign-scoped role is now
 * *effective* (see RoleResolver) and depends on which campaign is being
 * accessed, not the request as a whole.
 */
export interface RequestUser {
  id: string; // String(users.id) for real users, or 'dev:<name>' for header-based dev auth
  name: string;
  serverRole: ServerRole; // 'admin' | 'user'
  devRole?: Role; // set only on the DEV_AUTH header path; short-circuits RoleResolver
  tokenContext?: TokenContext; // set only on the PAT (Authorization: Bearer cf_pat_...) path
}

/**
 * Present on RequestUser.tokenContext (and mirrored onto req.tokenContext for
 * the @CurrentTokenContext() decorator) when the request authenticated via a
 * PAT rather than a session cookie. Caps the effective role (see
 * RoleResolver) and, if `campaignId` is set, restricts the token to that
 * single campaign. Carried on RequestUser itself (not just the raw request)
 * so every existing CampaignAccessService/RoleResolver call site picks up
 * the scope cap automatically, with no signature changes needed.
 */
export interface TokenContext {
  tokenId: number;
  name: string;
  scope: Role;
  /**
   * Server-enforced WRITE authority, independent of `scope` (which caps read/role):
   *  - 'direct'  — writes apply immediately (default; back-compat with every
   *                pre-#158 token). The `?proposed=true` flag is an opt-in.
   *  - 'propose' — every mutation is coerced into a pending proposal server-side,
   *                regardless of the flag; the token can never write canon directly.
   *  - 'none'    — read-only; every write is rejected.
   * See requireWriteMode() (proposed.util) and WriteModeGuard for enforcement.
   */
  writeScope: WriteScope;
  campaignId: number | null;
  /**
   * Whether this specific token is allowed to exercise SERVER-admin powers
   * (ServerRolesGuard-gated routes, install_rule_pack, etc). Independent of
   * `scope`, which only caps per-campaign role. Defaults false at mint time
   * (see ApiToken.adminEnabled in @campfire/schema) — an admin's token is NOT
   * server-admin-capable unless it was explicitly minted that way by a caller
   * who currently held real server-admin power. See hasServerAdminPower() below.
   */
  adminEnabled: boolean;
}

/** dm > player > viewer */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  player: 1,
  dm: 2,
};

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Lower of the two roles by ROLE_RANK — how a token's scope caps an effective role (RoleResolver, /me). */
export function minRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

/** direct (broadest write authority) > propose > none (read-only). */
export const WRITE_SCOPE_RANK: Record<WriteScope, number> = {
  none: 0,
  propose: 1,
  direct: 2,
};

/**
 * Narrower (less-privileged) of two write scopes by WRITE_SCOPE_RANK — how a
 * calling token caps the writeScope of a token it mints (TokensService.create),
 * mirroring minRole for the read dimension. A propose-only token can never mint a
 * direct-write sibling.
 */
export function minWriteScope(a: WriteScope, b: WriteScope): WriteScope {
  return WRITE_SCOPE_RANK[a] <= WRITE_SCOPE_RANK[b] ? a : b;
}

/** Audit-log / proposer actor string: `token:<name>` when acting via a PAT, else the user id. */
export function auditActor(user: RequestUser): string {
  return user.tokenContext ? `token:${user.tokenContext.name}` : user.id;
}

/**
 * Whether `user` may exercise SERVER-admin powers right now: ServerRolesGuard
 * (POST /users, /settings, etc) and the MCP install_rule_pack tool both gate on
 * this instead of the raw `user.serverRole === 'admin'` check.
 *
 * A token's `scope` (dm/player/viewer) only ever caps per-campaign role via
 * RoleResolver — it does NOT touch server-wide capability on its own. Without
 * this function, a viewer-scoped PAT minted for a server admin would still
 * carry that admin's serverRole through untouched and pass every server-admin
 * gate: the "least-privilege" token an operator hands an AI agent would
 * actually be root. See the P1 finding this closes.
 *
 * Rule: real serverRole must be 'admin' AND (not authenticated via a token, OR
 * the token was explicitly minted with adminEnabled=true). Session-cookie
 * logins have no tokenContext, so admins via cookie are unaffected — only the
 * PAT path is capped.
 */
export function hasServerAdminPower(user: RequestUser): boolean {
  if (user.serverRole !== 'admin') return false;
  if (!user.tokenContext) return true;
  return user.tokenContext.adminEnabled === true;
}
