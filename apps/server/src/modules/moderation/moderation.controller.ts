import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ModerationReportStatus } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { ModerationService } from './moderation.service';
import {
  ModerationActionRequestDto,
  ModerationEvidenceDto,
  ModerationIncidentExportDto,
  ModerationRedactRequestDto,
  ModerationReportCreateDto,
  ModerationReportDto,
  ModerationReportPageDto,
} from './moderation.dto';
import { parseModerationLimit } from './moderation-pagination';

/**
 * Campaign moderation surface (issue #601).
 *
 * THE ACCESS SPLIT, ENFORCED HERE AND IN THE SERVICE
 * --------------------------------------------------
 * Three distinct permission levels live under one route prefix, and they are NOT
 * the same as "can read campaign content":
 *
 *  1. FILE a report — any member, on content they can already see. Deliberately not
 *     gated on `{ write: true }`: reporting abuse must keep working in a paused or
 *     completed (archived, read-only) campaign, because harm does not stop when the
 *     table goes on hiatus.
 *  2. READ THE QUEUE — a DM sees the campaign queue; a non-DM sees only the reports
 *     they filed. Metadata only, in both cases. No evidence content is served by any
 *     list or get route.
 *  3. READ EVIDENCE / EXPORT / ACT — dm role, plus the service's conflicted-DM and
 *     escalation gates, plus an audit row on every single call.
 *
 * A DM's ability to read campaign content therefore does NOT imply the ability to
 * read abuse evidence: the evidence never travels on a content route, and the one
 * route that serves it is separately gated and separately logged. See
 * ModerationService.readEvidence.
 */
@ApiTags('moderation')
@Controller('campaigns/:campaignId/moderation')
export class ModerationController {
  constructor(
    private readonly moderation: ModerationService,
    private readonly access: CampaignAccessService,
  ) {}

  @Post('reports')
  @ApiOperation({
    summary: 'Report content or conduct',
    description:
      'Any campaign member. Covers comments, whispers, notes, notifications, AI narration, and general conduct ' +
      '(issue #601). The reporter must already be able to SEE the target under that surface\'s own visibility rule — ' +
      'reporting can never be used to probe for a hidden entity or someone else\'s whisper (uniform 404). ' +
      'An integrity-protected snapshot of the content, its revision, and its context is captured atomically with the ' +
      'report, so a concurrent edit or delete by the author cannot erase what was reported. ' +
      'Allowed on an archived (read-only) campaign: safety reporting must not depend on campaign status.',
  })
  @ApiResponse({ status: 201, description: 'The filed report (metadata only — evidence content is never returned here).', type: ModerationReportDto })
  @ApiResponse({ status: 400, description: 'Target/payload mismatch (e.g. `content` supplied for a server-captured target).' })
  @ApiResponse({ status: 404, description: 'Target missing, in another campaign, or not visible to the reporter.' })
  async createReport(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: ModerationReportCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.moderation.createReport(campaignId, body, user, role);
  }

  @Get('reports')
  @ApiOperation({
    summary: 'List moderation reports',
    description:
      'A DM sees this campaign\'s queue; any other member sees only the reports they filed themselves. ' +
      'METADATA ONLY — no evidence content is served by this route. Escalated reports are excluded from the DM ' +
      'queue entirely (they have left DM jurisdiction for server-admin review), as are reports whose subject is ' +
      'the requesting DM. Newest-first; continue with `cursor` from a previous `nextCursor`.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ModerationReportStatus.options, description: 'Filter to one lifecycle state.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max reports per page (default 25, max 100).' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: "Opaque cursor from a previous page's nextCursor." })
  @ApiResponse({ status: 200, description: 'Paginated report page.', type: ModerationReportPageDto })
  async listReports(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.moderation.listReports(campaignId, user, role, {
      status: status ? ModerationReportStatus.parse(status) : undefined,
      limit: parseModerationLimit(limit),
      cursor,
    });
  }

  @Get('reports/:reportId')
  @ApiOperation({
    summary: 'Get one moderation report',
    description:
      'Metadata only. A DM may read any non-escalated report in the campaign except one about themselves; any other ' +
      'member may read only their own. Reading the reported CONTENT requires the separate, audited evidence route.',
  })
  @ApiResponse({ status: 200, description: 'Report metadata.', type: ModerationReportDto })
  async getReport(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.moderation.getReport(campaignId, reportId, user, role);
  }

  @Get('reports/:reportId/evidence')
  @ApiOperation({
    summary: 'Read the evidence snapshot behind a report (audited)',
    description:
      'dm role required, and the requesting DM must not be the subject of the report (404 if they are) — a DM has no ' +
      'authority over an incident about themselves. Escalated reports are refused (403). ' +
      'EVERY call writes a `moderation.evidence.access` audit row naming who read which evidence when. ' +
      'The response reports the snapshot\'s integrity (`intact` / `redacted` / `tampered`) recomputed from its sha256 ' +
      'digest. Snapshots past their retention horizon are redacted on the way out. There is deliberately no bulk ' +
      'evidence list: a browsable archive of abuse content is itself a hazard.',
  })
  @ApiResponse({ status: 200, description: 'The evidence snapshot.', type: ModerationEvidenceDto })
  @ApiResponse({ status: 403, description: 'Report escalated to server-admin review.' })
  async readEvidence(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.moderation.readEvidence(campaignId, reportId, user, role);
  }

  @Get('reports/:reportId/export')
  @ApiOperation({
    summary: 'Export one incident (audited)',
    description:
      'dm role required, same conflicted-DM and escalation gates as the evidence route. Returns the report, the ' +
      'evidence snapshot with its integrity verdict, and the incident\'s own audit timeline as a self-contained ' +
      'bundle suitable for a safeguarding referral. Recorded as `moderation.incident.export`, distinct from a read, ' +
      'so "someone took a copy off the box" is visible in the trail.',
  })
  @ApiResponse({ status: 200, description: 'Incident export bundle.', type: ModerationIncidentExportDto })
  async exportIncident(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('reportId', ParseIntPipe) reportId: number,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.moderation.exportIncident(campaignId, reportId, user, role);
  }

  @Post('reports/:reportId/redact')
  @ApiOperation({
    summary: 'Redact an evidence snapshot early (audited)',
    description:
      'dm role required. Replaces the snapshot content with a placeholder before its retention horizon — for material ' +
      'that must stop being retained immediately (for example because it depicts a minor). The report, the original ' +
      'hash, and the audit timeline survive, so the record that an incident occurred is never destroyed; the snapshot ' +
      'then reads back with integrity `redacted` rather than `tampered`. A written `reason` is required.',
  })
  @ApiResponse({ status: 201, description: 'The redacted snapshot.', type: ModerationEvidenceDto })
  async redactEvidence(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() body: ModerationRedactRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.moderation.redactEvidence(campaignId, reportId, body.reason, user, role);
  }

  @Post('reports/:reportId/actions')
  @ApiOperation({
    summary: 'Act on a moderation report',
    description:
      'The DM queue verbs: acknowledge, quarantine, unquarantine, mute, unmute, remove, escalate, resolve (issue #601). ' +
      'dm role required for all of them EXCEPT `escalate`, which the report\'s own reporter may also invoke — that is ' +
      'the appeal valve for "the DM is the problem". Quarantine genuinely withholds the content from normal reads; ' +
      'resolving as `rejected` (the false-report outcome) lifts any quarantine this report caused. Every action is ' +
      'recorded in the campaign audit log as `moderation.<action>`.',
  })
  @ApiResponse({ status: 201, description: 'The updated report.', type: ModerationReportDto })
  @ApiResponse({ status: 400, description: 'Action not applicable to this target (e.g. quarantine on a conduct report).' })
  async act(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('reportId', ParseIntPipe) reportId: number,
    @Body() body: ModerationActionRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    // requireMember (not requireRole 'dm'): `escalate` is open to the reporter. The
    // service applies the dm gate to every other verb — keeping that decision in one
    // place rather than splitting it across two routes that could drift apart.
    const role = await this.access.requireMember(user, campaignId, { allowArchived: true });
    return this.moderation.act(campaignId, reportId, body, user, role);
  }

  @Get('mutes')
  @ApiOperation({
    summary: 'List active posting mutes',
    description:
      'dm role required. The mutes currently blocking members from posting comments or notes in this campaign. ' +
      'A mute is keyed on the member id rather than their membership row, so leaving and rejoining does not clear it.',
  })
  @ApiResponse({ status: 200, description: 'Active mutes.' })
  async listMutes(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.moderation.listMutes(campaignId);
  }
}
