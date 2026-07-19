import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Role } from '@campfire/schema';
import { roleAtLeast, type RequestUser } from '../../common/user.types';
import { RoleResolver } from './role-resolver.service';

/**
 * Thin convenience wrapper around RoleResolver for domain services: resolve
 * the effective role for (user, campaignId), 403 if not a member, optionally
 * assert a minimum rank (dm > player > viewer).
 */
@Injectable()
export class CampaignAccessService {
  constructor(private readonly roleResolver: RoleResolver) {}

  async effectiveRole(user: RequestUser, campaignId: number): Promise<Role | null> {
    return this.roleResolver.effectiveRole(user, campaignId);
  }

  /** 403 if the user is not a member of this campaign at all. */
  async requireMember(user: RequestUser, campaignId: number): Promise<Role> {
    const role = await this.roleResolver.effectiveRole(user, campaignId);
    if (!role) throw new ForbiddenException('Not a member of this campaign');
    return role;
  }

  /** 403 if the user is not at least `min` in this campaign (also covers non-membership). */
  async requireRole(user: RequestUser, campaignId: number, min: Role): Promise<Role> {
    const role = await this.requireMember(user, campaignId);
    if (!roleAtLeast(role, min)) {
      throw new ForbiddenException(`Requires role: ${min}`);
    }
    return role;
  }
}
