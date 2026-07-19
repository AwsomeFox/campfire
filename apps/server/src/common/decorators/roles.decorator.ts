import { SetMetadata } from '@nestjs/common';
import type { Role } from '@campfire/schema';

export const ROLES_KEY = 'roles';

/**
 * DEPRECATED for campaign-scoped routes: campaign role is now resolved
 * per-request via CampaignAccessService.requireRole() in the service layer
 * (role is not knowable from headers alone anymore — it depends on which
 * campaign is being accessed). Kept only for reference; no controller in
 * this codebase should reach for this anymore. See ServerRoles() below for
 * the admin-gating replacement.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
