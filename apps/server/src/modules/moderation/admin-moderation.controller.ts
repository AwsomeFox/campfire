import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { auditActor, auditActorRole, type RequestUser } from '../../common/user.types';
import { ModerationService } from './moderation.service';
import {
  ModerationActionRequestDto,
  ModerationBreakGlassDto,
  ModerationIncidentExportDto,
  ModerationReportDto,
  ModerationReportPageDto,
  ModerationRetentionPolicyUpdateDto,
} from './moderation.dto';
import { parseModerationLimit } from './moderation-pagination';

/**
 * Server-admin moderation: break-glass, not a console (issue #601 bullet 5).
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * Two of the issue's findings are really one problem: "campaign audit is DM-only
 * while server-admin audit excludes campaign rows" means there is no legitimate
 * path for a server operator to review a campaign incident — and no record when
 * one does it anyway. And when the DM is themselves the subject of a report,
 * there is nobody inside the campaign with the standing to act.
 *
 * WHAT MAKES IT BREAK-GLASS RATHER THAN BROWSING
 * ----------------------------------------------
 *  - There is no route that returns evidence content in bulk. The escalation LIST
 *    returns metadata only, so an admin can see that something needs attention
 *    without reading anyone's words — and even that listing is audited.
 *  - Reading one incident requires POSTing an explicit written `justification`
 *    (min 10 chars, enforced twice). It is a POST rather than a GET precisely
 *    because it is an act with a side effect: the recorded justification.
 *  - Every invocation writes TWO audit rows — one campaign-scoped so the
 *    campaign's own trail shows an outside reader arrived, one server-scoped
 *    (campaign_id null) so the server-admin trail, which excludes campaign rows,
 *    shows it too. That double-write is the direct fix for the audit blind spot
 *    the issue names, and it closes it without merging the two access levels.
 *  - @ServerRoles('admin') routes through ServerRolesGuard + hasServerAdminPower,
 *    so a scope-capped PAT owned by an admin cannot reach any of this.
 */
@ApiTags('moderation')
@Controller('admin/moderation')
@ServerRoles('admin')
export class AdminModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get('reports')
  @ApiOperation({
    summary: 'List escalated incidents (metadata only, audited)',
    description:
      'Server-admin only. Incidents that have left DM jurisdiction — either escalated explicitly, or auto-escalated ' +
      'at creation because the reported member holds the dm role in that campaign. METADATA ONLY: no evidence ' +
      'content is returned, because knowing an escalation exists is operational necessity while reading its words ' +
      'is not. The listing itself is recorded as `moderation.admin.list`.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max reports per page (default 25, max 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: "Opaque cursor from a previous page's nextCursor." })
  @ApiResponse({ status: 200, description: 'Paginated escalated-report page.', type: ModerationReportPageDto })
  async listEscalated(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.moderation.adminListEscalated(user, { limit: parseModerationLimit(limit), cursor });
  }

  @Post('reports/:reportId/break-glass')
  @ApiOperation({
    summary: 'Break-glass: read one incident in full (audited twice)',
    description:
      'Server-admin only. Returns the report, its evidence snapshot with an integrity verdict, and the incident audit ' +
      'timeline, across campaign boundaries. Requires a written `justification` of at least 10 characters, which is ' +
      'recorded verbatim in BOTH a campaign-scoped and a server-scoped audit row. There is no unjustified variant and ' +
      'no bulk-content variant: this is a per-incident, on-the-record act, not an admin browsing surface.',
  })
  @ApiResponse({ status: 201, description: 'Incident export bundle.', type: ModerationIncidentExportDto })
  @ApiResponse({ status: 400, description: 'Missing or too-short justification.' })
  async breakGlass(
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() body: ModerationBreakGlassDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.moderation.adminBreakGlass(reportId, body.justification, user);
  }

  @Post('reports/:reportId/resolve')
  @ApiOperation({
    summary: 'Resolve an escalated incident',
    description:
      'Server-admin only — the far end of the escalation path, including the conflicted-DM case where nobody inside ' +
      'the campaign has standing to act. Resolving as `rejected` lifts any quarantine the report caused, exactly as ' +
      'the DM-side resolve does, so an escalated false report does not leave content suppressed forever.',
  })
  @ApiResponse({ status: 201, description: 'The resolved report.', type: ModerationReportDto })
  async resolve(
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() body: ModerationActionRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.moderation.adminResolve(reportId, body, user);
  }

  @Get('retention')
  @ApiOperation({
    summary: 'Read the moderation evidence retention policy',
    description:
      'Server-admin only. `days` INHERITS the audit retention policy unless a moderation-specific override is stored ' +
      '(`source` says which). Unlike audit pruning, expiry REDACTS snapshot content rather than deleting rows: the ' +
      'report shell, hashes, and timeline survive so the record that an incident happened is never destroyed.',
  })
  @ApiResponse({ status: 200, description: 'Effective moderation retention policy.' })
  getRetention() {
    return this.moderation.getRetentionPolicy();
  }

  @Patch('retention')
  @ApiOperation({
    summary: 'Update the moderation evidence retention policy',
    description: 'Server-admin only. Records `moderation.retention.update` in the server-admin audit trail.',
  })
  @ApiResponse({ status: 200, description: 'Updated effective policy.' })
  updateRetention(@Body() body: ModerationRetentionPolicyUpdateDto, @CurrentUser() user: RequestUser) {
    return this.moderation.updateRetentionPolicy(body, { actor: auditActor(user), actorRole: auditActorRole(user) });
  }

  @Post('retention/sweep')
  @ApiOperation({
    summary: 'Redact every expired evidence snapshot now',
    description:
      'Server-admin only. Retention is also applied lazily on read (an expired snapshot is redacted on the way out, ' +
      'so it can never be served stale); this endpoint applies it eagerly across the whole table. Idempotent — ' +
      'already-redacted snapshots are skipped. Each redaction records `moderation.evidence.redact`.',
  })
  @ApiResponse({ status: 201, description: 'Number of snapshots redacted.' })
  async sweep(@CurrentUser() user: RequestUser) {
    const redacted = await this.moderation.redactExpired({
      actor: auditActor(user),
      actorRole: auditActorRole(user),
    });
    return { redacted };
  }
}
