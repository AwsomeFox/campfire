import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ExpectedUpdatedAt, RevisionEntityType } from '@campfire/schema';
import type { Role, RevisionEntityType as RevisionEntityTypeValue } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { canSee } from '../notes/notes.service';
import { RevisionsService } from './revisions.service';

/**
 * Prose revision history (issue #157/#233). Generic over the supported entity types —
 * one place to list an entity's prior-content snapshots and restore one.
 *
 * Access has two shapes, matching each entity's own edit path:
 *  - World-building prose (session/quest/npc/location/faction): dm-gated on the entity's
 *    OWN campaign (resolved from the live row), matching their uniformly dm-only edits.
 *  - Notes: gated on the NOTE'S own visibility (canSee) for reads and author-only for
 *    restore — never a blanket dm-gate, so a private note's history is not a redaction
 *    back-door for a DM who couldn't otherwise see it (issue #233).
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
      throw new BadRequestException(
        `Unsupported revision entityType: ${entityType} (expected session|quest|npc|location|faction|note)`,
      );
    }
    return parsed.data;
  }

  /**
   * Resolve the access role for a revision request, branching on entity kind:
   *  - note: the note must exist + be visible to the caller (canSee); reads need only
   *    membership, restore additionally requires authorship (checked by the caller).
   *  - everything else: the entity's campaign must grant the caller the `dm` role.
   * Returns the caller's role (for the audit trail on restore) alongside the campaignId.
   */
  private async resolveNoteAccess(
    entityId: number,
    user: RequestUser,
    opts: { write: boolean },
  ): Promise<{ campaignId: number; role: Role; authorUserId: string }> {
    const note = await this.revisions.loadNoteAccess(entityId);
    if (!note) throw new NotFoundException(`note ${entityId} not found`);
    const role = await this.access.requireMember(user, note.campaignId, opts.write ? { write: true } : undefined);
    // A note the caller can't see 404s (not 403), exactly like GET /notes/:id — its very
    // existence stays hidden. This is the redaction guard: a DM never reaches a private
    // note's history through this generic endpoint.
    if (!canSee(note, user, role)) throw new NotFoundException(`note ${entityId} not found`);
    return { campaignId: note.campaignId, role, authorUserId: note.authorUserId };
  }

  @Get(':entityType/:entityId')
  @ApiOperation({
    summary: 'List an entity\'s prose revision history',
    description:
      'Newest-first snapshots of an entity\'s PRIOR prose (session recap, or quest/npc/location/faction/note body), ' +
      'one per committed change (issue #157/#233). dm role required for world-building entities; a note\'s history is ' +
      'gated on the note\'s own visibility instead. Empty when the entity has never been edited since revisions were introduced.',
  })
  @ApiResponse({ status: 200, description: 'The entity\'s revisions, newest first.' })
  async list(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const type = this.parseEntityType(entityType);
    if (type === 'note') {
      await this.resolveNoteAccess(entityId, user, { write: false });
    } else {
      const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId);
      await this.access.requireRole(user, campaignId, 'dm');
    }
    return this.revisions.listForEntity(type, entityId);
  }

  @Post(':entityType/:entityId/:revisionId/restore')
  @ApiOperation({
    summary: 'Restore a prior revision',
    description:
      'Re-applies a prior snapshot as a new update — the CURRENT content is first captured as its own revision, so a ' +
      'restore is itself reversible. Snapshot, content update, revision tip, and audit commit in one database ' +
      'transaction (issue #513). Optionally pass `expectedUpdatedAt` (the updatedAt you last read) to opt into the ' +
      'same optimistic-concurrency guard as prose PATCH — a concurrent edit returns 409. dm role required for ' +
      'world-building entities; a note may be restored only by its author. Returns the refreshed revision list.',
  })
  @ApiQuery({
    name: 'expectedUpdatedAt',
    required: false,
    type: String,
    description:
      'Optimistic-concurrency guard (issue #513 / #157): the updatedAt you last read. If stale, restore 409s.',
  })
  @ApiResponse({ status: 201, description: 'Restored; body carries the updated entity ref + fresh revision list.' })
  @ApiResponse({ status: 409, description: 'Stale expectedUpdatedAt — another edit landed since you loaded the entity.' })
  async restore(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @Param('revisionId', ParseIntPipe) revisionId: number,
    @Query('expectedUpdatedAt') expectedUpdatedAt: string | undefined,
    @CurrentUser() user: RequestUser,
  ) {
    const type = this.parseEntityType(entityType);
    // Query params arrive as strings; reuse the shared ExpectedUpdatedAt schema so an
    // oversized/invalid token 400s instead of reaching the CAS compare.
    const parsedGuard = ExpectedUpdatedAt.safeParse(expectedUpdatedAt);
    if (!parsedGuard.success) {
      throw new BadRequestException(parsedGuard.error.issues[0]?.message ?? 'Invalid expectedUpdatedAt');
    }
    const opts = { expectedUpdatedAt: parsedGuard.data };
    if (type === 'note') {
      // Restoring a note's prose is an edit — author-only, mirroring note update/delete.
      const { authorUserId, role } = await this.resolveNoteAccess(entityId, user, { write: true });
      if (authorUserId !== user.id) throw new ForbiddenException('Only the author may restore this note');
      return this.revisions.restore(type, entityId, revisionId, user, role, opts);
    }
    const campaignId = await this.revisions.campaignIdForEntityOrThrow(type, entityId);
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.revisions.restore(type, entityId, revisionId, user, role, opts);
  }
}
