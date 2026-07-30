import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SessionZeroConsentService } from './session-zero-consent.service';
import {
  SessionZeroAcknowledgmentDto,
  SessionZeroAcknowledgmentInputDto,
  SessionZeroBoundarySubmissionCreateDto,
  SessionZeroBoundarySubmissionDto,
  SessionZeroCharterPublishDto,
  SessionZeroCharterVersionDto,
  SessionZeroConsentStatusDto,
  SessionZeroGuardianConsentDecisionDto,
  SessionZeroGuardianConsentDto,
  SessionZeroGuardianConsentRequestDto,
  SessionZeroPreviewPolicyUpdateDto,
} from './session-zero.dto';

/**
 * Session-zero consent lifecycle (issue #600).
 *
 * Sits alongside SessionZeroController, which continues to own the DM's mutable DRAFT.
 * The split is the design: editing the draft is a private act that consents to nothing,
 * while PUBLISHING freezes a version that participants answer individually. Keeping the
 * two on separate controllers stops the draft's PUT from ever quietly becoming a
 * consent-affecting operation.
 */
@ApiTags('session-zero')
@Controller('campaigns/:campaignId/session-zero')
export class SessionZeroConsentController {
  constructor(
    private readonly consent: SessionZeroConsentService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get('versions')
  @ApiOperation({
    summary: 'List published charter versions (newest first)',
    description:
      'Any member. Immutable snapshots of the charter — each one is what somebody was asked to agree to. `material` ' +
      'marks a version that WITHDREW a protection relative to its predecessor, which is the only kind of change that ' +
      'invalidates an existing acknowledgment.',
  })
  @ApiResponse({ status: 200, description: 'Published versions.', type: [SessionZeroCharterVersionDto] })
  async listVersions(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.consent.listVersions(campaignId);
  }

  @Post('versions')
  @ApiOperation({
    summary: 'Publish the current draft as the next immutable version (DM only)',
    description:
      'DM only. Snapshots the working draft into a new version. Whether the change is MATERIAL is computed from the ' +
      'previous version and frozen onto the row — it is never self-declared by the DM, because a self-declared safety ' +
      'flag is the version of this feature that quietly does nothing. Publishing an unchanged or empty draft is ' +
      'refused. Notifies the whole table via the always-on `access` notification category.',
  })
  @ApiResponse({ status: 201, description: 'The new immutable version.', type: SessionZeroCharterVersionDto })
  @ApiResponse({ status: 400, description: 'Draft is empty or identical to the current version.' })
  async publish(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionZeroCharterPublishDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.consent.publish(campaignId, body, user);
  }

  @Get('consent')
  @ApiOperation({
    summary: 'The campaign consent gate: latest version, effective version, who is outstanding',
    description:
      'Any member. `effectiveVersion` is what play and live AI are licensed against, and it is NOT simply the newest ' +
      'version — a version that withdrew a protection does not take effect until every seated DM and player has ' +
      'acknowledged it. Until then the table keeps operating under the last version everybody actually agreed to. ' +
      '`awaitingRenewal` plus `diff` describe exactly what is being asked.',
  })
  @ApiResponse({ status: 200, description: 'Consent gate status.', type: SessionZeroConsentStatusDto })
  async consentStatus(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.consent.consentStatus(campaignId, user, role === 'dm');
  }

  @Post('consent')
  @ApiOperation({
    summary: 'Acknowledge, ask to discuss, or decline one charter version',
    description:
      'Any member, answering for themselves. `discuss` is its own state rather than a soft decline: a participant who ' +
      'wants to talk about a line before agreeing has not refused, and has not agreed either. Both `discuss` and ' +
      '`declined` hold the consent gate closed, and both require a note so the objection is legible to the DM. ' +
      'Answering again updates the same record rather than adding a second opinion.',
  })
  @ApiResponse({ status: 201, description: 'The recorded answer.', type: SessionZeroAcknowledgmentDto })
  @ApiResponse({ status: 400, description: 'discuss/decline without a note.' })
  async acknowledge(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionZeroAcknowledgmentInputDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMemberOnWritableCampaign(user, campaignId);
    return this.consent.acknowledge(campaignId, body, user);
  }

  @Put('preview-policy')
  @ApiOperation({
    summary: 'How much of the charter an invite link discloses (DM only)',
    description:
      "DM only. `boundaries` (default) discloses lines, veils and safety tools — the floor somebody needs in order to " +
      'decline meaningfully. `full` additionally discloses the house-rules and tone prose. There is deliberately no ' +
      '`none`: a table unwilling to show its boundaries should not be handing out public join links, and an opt-out ' +
      'here would restore the exact gap this feature closes.',
  })
  @ApiResponse({ status: 200, description: 'Updated.' })
  async setPreviewPolicy(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionZeroPreviewPolicyUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    await this.consent.setPreviewPolicy(campaignId, body.previewPolicy, user);
    return { previewPolicy: body.previewPolicy };
  }

  // ---- private boundary submissions ----

  @Get('boundaries')
  @ApiOperation({
    summary: 'Private boundaries — your own, or all of them if you facilitate',
    description:
      'A participant sees only their own submissions. The DM sees all of them, but an ANONYMOUS submission arrives ' +
      'with its submitter fields emptied server-side rather than merely hidden in the UI — a payload that carried the ' +
      'id and trusted the client to conceal it would leak through the API, the network tab, and every future consumer.',
  })
  @ApiResponse({ status: 200, description: 'Visible submissions.', type: [SessionZeroBoundarySubmissionDto] })
  async listBoundaries(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireMember(user, campaignId);
    return this.consent.listBoundarySubmissions(campaignId, user, role === 'dm');
  }

  @Post('boundaries')
  @ApiOperation({
    summary: 'Send a boundary privately to the facilitator',
    description:
      'Any member. The channel for the line somebody cannot say in front of the group. Never shown to other ' +
      'participants, never included in any campaign export, and never sent to a model. `anonymous` additionally ' +
      'withholds the submitter from the DM, who can then honour the boundary without learning whose it is.',
  })
  @ApiResponse({ status: 201, description: 'The submission.', type: SessionZeroBoundarySubmissionDto })
  async createBoundary(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionZeroBoundarySubmissionCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMemberOnWritableCampaign(user, campaignId);
    return this.consent.createBoundarySubmission(campaignId, body, user);
  }

  @Delete('boundaries/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Withdraw your own private boundary',
    description:
      'Only the participant who submitted it. A facilitator deliberately cannot delete somebody else\'s boundary — ' +
      'the submission belongs to the person who made it.',
  })
  @ApiResponse({ status: 204, description: 'Withdrawn.' })
  async deleteBoundary(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMemberOnWritableCampaign(user, campaignId);
    await this.consent.deleteBoundarySubmission(campaignId, id, user);
  }

  // ---- guardian consent ----

  @Get('guardian-consents')
  @ApiOperation({
    summary: 'Guardian consent records for this campaign (DM only)',
    description:
      'DM only. Records carry a guardian contact and a single `minorAttested` assertion. They contain NO date of ' +
      'birth, age, or birth year — the requirement is that the identifier is never collected, so there is no column ' +
      'holding one and no request field that accepts one.',
  })
  @ApiResponse({ status: 200, description: 'Guardian consents.', type: [SessionZeroGuardianConsentDto] })
  async listGuardians(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.consent.listGuardianConsents(campaignId);
  }

  @Post('guardian-consents')
  @ApiOperation({
    summary: 'Open a guardian consent request for yourself',
    description:
      'A participant opens the flow for their own seat, naming a guardian and attesting that they are below the age ' +
      'of majority where they live. `minorAttested` is a single boolean assertion, deliberately not a threshold, a ' +
      'jurisdiction, or anything a birth date could be reconstructed from. The body is strict: sending `birthDate` ' +
      'or `age` is a 400.',
  })
  @ApiResponse({ status: 201, description: 'The pending request.', type: SessionZeroGuardianConsentDto })
  @ApiResponse({ status: 400, description: 'Unrecognized field (e.g. a birth date) or missing attestation.' })
  async requestGuardian(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: SessionZeroGuardianConsentRequestDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireMemberOnWritableCampaign(user, campaignId);
    return this.consent.requestGuardianConsent(
      campaignId,
      body,
      { userId: user.id, userName: user.name ?? '' },
      user,
      role,
    );
  }

  @Post('guardian-consents/:id/decision')
  @ApiOperation({
    summary: 'Record a guardian decision (DM only)',
    description:
      'DM only — the facilitator records the answer a guardian gave them out of band. Withdrawal is available after ' +
      'a grant, because consent that cannot be withdrawn is not consent.',
  })
  @ApiResponse({ status: 201, description: 'The decided record.', type: SessionZeroGuardianConsentDto })
  async decideGuardian(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SessionZeroGuardianConsentDecisionDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm', { allowArchived: true });
    return this.consent.decideGuardianConsent(campaignId, id, body, user);
  }
}
