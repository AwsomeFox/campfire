import { Module } from '@nestjs/common';
import { RoleResolver } from './role-resolver.service';
import { CampaignAccessService } from './campaign-access.service';

/**
 * Leaf module (no dependency on AuditModule or any domain module) so every
 * campaign-scoped module — including AuditModule itself — can import it
 * without creating a cycle. MembershipModule (member CRUD + audit logging)
 * builds on top of this.
 */
@Module({
  providers: [RoleResolver, CampaignAccessService],
  exports: [RoleResolver, CampaignAccessService],
})
export class RoleAccessModule {}
