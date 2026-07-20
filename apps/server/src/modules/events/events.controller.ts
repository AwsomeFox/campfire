import { Controller, Param, ParseIntPipe, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { interval, merge, map, type Observable } from 'rxjs';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignEventsService } from './campaign-events.service';

/**
 * Keepalive cadence. Long enough to be negligible traffic, short enough that
 * typical reverse-proxy idle timeouts (usually 60s+) never cut a quiet stream.
 */
const HEARTBEAT_MS = 25_000;

@ApiTags('events')
@Controller('campaigns/:campaignId/events')
export class CampaignEventsController {
  constructor(
    private readonly events: CampaignEventsService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Auth rides the global SessionAuthGuard (cookie/PAT/dev headers) like every
   * other route; membership is asserted here before the stream is returned, so
   * a non-member gets a plain 403 JSON response, never an open stream.
   */
  @Sse()
  @ApiOperation({
    summary: 'Subscribe to campaign events (SSE)',
    description:
      'Requires campaign membership. Server-sent event stream of thin change signals ' +
      '(CampaignEvent JSON in `data`); clients refetch affected resources on receipt. ' +
      'Periodic `{"type":"ping"}` keepalives should be ignored.',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ status: 200, description: 'text/event-stream of CampaignEvent JSON.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async stream(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<Observable<MessageEvent>> {
    await this.access.requireMember(user, campaignId);
    return merge(
      this.events.streamFor(campaignId).pipe(map((event): MessageEvent => ({ data: event }))),
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ data: { type: 'ping' } }))),
    );
  }
}
