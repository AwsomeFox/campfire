import { BadRequestException, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RevisionEntityType } from '@campfire/schema';
import type { RevisionEntityType as RevisionEntityTypeValue } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { RevisionsService } from './revisions.service';

/**
 * Prose revision history (issue #157). Generic over the four supported entity types
 * (session/quest/npc/location) — one place to list an entity's prior-content snapshots
 * and restore one. Both routes are dm-gated on the entity's OWN campaign (resolved from
 * the live row), matching those entities' uniformly dm-only edit path.
 */
@ApiTags('revisions')
@Controller('revisions')
export class RevisionsController {
  constructor(
    private readonly revisions: RevisionsService,
    private readonly access: CampaignAccessService,
  ) {}

  private parseEntityType(entityType: string): RevisionEntityTypeValue {
    const parsed = RevisionEntityType.safeParse(entityType);
    if (!parsed.success) {
      throw new BadRequestException(`Unsupported revision entityType: ${entityType} (expected session|quest|npc|location)`);
    }
    return parsed.data;
  }

  @Get(':entityType/:entityId')
  @ApiOperation({
    summary: 'List an entity\'s prose revision history',
    description:
      'dm role required. Newest-first snapshots of an entity\'s PRIOR prose (session recap, or quest/npc/location body), ' +
      'one per committed change (issue #157). Empty when the entity has never been edited since revisions were introduced.',
  })
  @ApiResponse({ status: 200, description: 'The entity\'s revisions, newest first.' })
  async list(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const type = this.parseEntityType(entityType);
    const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId);
    await this.access.requireRole(user, campaignId, 'dm');
    return this.revisions.listForEntity(type, entityId);
  }

  @Post(':entityType/:entityId/:revisionId/restore')
  @ApiOperation({
    summary: 'Restore a prior revision',
    description:
      'dm role required. Re-applies a prior snapshot as a new update — the CURRENT content is first captured as its own ' +
      'revision, so a restore is itself reversible. Returns the refreshed revision list.',
  })
  @ApiResponse({ status: 201, description: 'Restored; body carries the updated entity ref + fresh revision list.' })
  async restore(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @Param('revisionId', ParseIntPipe) revisionId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const type = this.parseEntityType(entityType);
    const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId);
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.revisions.restore(type, entityId, revisionId, user, role);
  }
}
