import type { Role, ServerRole } from '@campfire/schema';

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
  campaignId: number | null;
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

/** Audit-log / proposer actor string: `token:<name>` when acting via a PAT, else the user id. */
export function auditActor(user: RequestUser): string {
  return user.tokenContext ? `token:${user.tokenContext.name}` : user.id;
}
