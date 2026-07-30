import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { TableSafetyHoldActivate, TableSafetyHoldRelease } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WriteModeExempt } from '../../common/decorators/proposable.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { SessionZeroService } from '../session-zero/session-zero.service';
import { TableSafetyService } from './table-safety.service';

class TableSafetyHoldActivateDto extends createZodDto(TableSafetyHoldActivate) {}
class TableSafetyHoldReleaseDto extends createZodDto(TableSafetyHoldRelease) {}

/**
 * The participant-facing table safety hold (X-Card) — issue #599.
 *
 * `@WriteModeExempt()` on purpose. The blunt HTTP write-mode guard exists to funnel canon
 * edits through the proposal queue on a read-only or proposal-only campaign; a safety stop is
 * neither canon nor an edit, and a table that has been switched to proposal-only must not
 * thereby lose its ability to stop play. The same reasoning the AI driver's control endpoints
 * already use.
 *
 * WHY THE ROLE CHECKS ARE WHAT THEY ARE
 *
 *  - Activation uses `requireMember`, the WEAKEST check in this codebase (a plain
 *    membership read-gate, no writable assertion). Not `requireRole('player')`: a viewer
 *    sitting at the table — a guest, a partner watching over someone's shoulder on their
 *    own login — is a person in the room, and the mechanism is worthless if it only
 *    protects people with a character sheet. Not `requireMemberOnWritableCampaign` either
 *    (issue #1480): that asserts campaign writability and would make an
 *    archived-but-still-being-read campaign un-stoppable. Every gate that consults the
 *    hold is a play-advancement gate, so a hold on a campaign nobody is advancing is
 *    inert anyway.
 *
 *  - Release uses `requireRole('dm')`. This is the asymmetry the whole design rests on: because
 *    a hold can only be lifted by a facilitator, letting anyone raise one is safe.
 */
@ApiTags('safety')
@WriteModeExempt()
@Controller('campaigns/:campaignId/safety')
export class TableSafetyController {
  constructor(
    private readonly safety: TableSafetyService,
    private readonly access: CampaignAccessService,
    private readonly sessionZero: SessionZeroService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Read the table's current safety-hold state",
    description:
      'Requires campaign membership. Returns whether play is currently frozen, when the hold was raised, ' +
      'and how the last hold was resolved. An anonymous hold reports `activatedByName: null` — which is the ' +
      'same value a campaign with no hold reports, deliberately.',
  })
  @ApiResponse({ status: 200, description: 'The current table safety hold.' })
  async get(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.safety.getHold(campaignId);
  }

  @Post('hold')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Raise the table safety hold (X-Card) — any member, no reason, no vote',
    description:
      'Requires campaign membership only — any seated participant including a viewer. Freezes encounter ' +
      'advancement and the AI seat (input, in-flight output, and queued tool dispatch) immediately. ' +
      'Idempotent: raising a hold that is already active succeeds and changes nothing, so two participants ' +
      'activating simultaneously both succeed and the table pauses once. Never requires a vote. Only a ' +
      'facilitator can release it.',
  })
  @ApiResponse({ status: 200, description: 'The active hold.' })
  async hold(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: TableSafetyHoldActivateDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireMember(user, campaignId);
    // THE ANONYMITY BOUNDARY IS THIS LINE. `user` is needed above to prove membership and is
    // then discarded: an anonymous activation passes `null` and the service is never given a
    // name or an id to persist, log, or broadcast. Doing it here rather than "hiding" the
    // identity downstream is what makes the guarantee auditable — there is exactly one place
    // to check, and no storage column that could ever be un-redacted by a later change.
    const actor = body.anonymous ? null : { id: user.id, name: user.name?.trim() || user.id };
    return this.safety.activate(campaignId, actor);
  }

  @Post('release')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve the table safety hold — facilitator only',
    description:
      'dm role required. `recovery` records how the table moved on: resume, rewind, veil, scene_change, or ' +
      'end. Only `resume` un-freezes the AI seat; the other four leave it paused so the facilitator can ' +
      'reset the fiction before the AI narrates again, and then resume it explicitly. With ' +
      "`recovery: 'veil'` an optional `veil` string is appended to the session-zero charter so the stop " +
      'actually changes what the table (and the AI, which reads the same charter) plays going forward.',
  })
  @ApiResponse({ status: 200, description: 'The released hold.' })
  @ApiResponse({ status: 403, description: 'Not a facilitator.' })
  async release(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: TableSafetyHoldReleaseDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    const facilitator = user.name?.trim() || user.id;

    // The charter edit happens BEFORE the release so the veil is in force the instant play is
    // ungated. Best-effort: a failure to write the charter must not strand the table in a hold
    // the facilitator has already decided to lift.
    if (body.recovery === 'veil' && body.veil) {
      try {
        const charter = await this.sessionZero.get(campaignId);
        if (!charter.veils.includes(body.veil)) {
          await this.sessionZero.update(campaignId, { veils: [...charter.veils, body.veil] }, user, role);
        }
      } catch {
        /* charter update is a courtesy; the release is the contract */
      }
    }

    return this.safety.release(campaignId, facilitator, body.recovery, body.note ?? null, user.id);
  }
}
