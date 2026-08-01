import { Controller, Param, ParseIntPipe, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { interval, merge, map, type Observable } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignEventsService } from './campaign-events.service';
import { projectCampaignEventForRole } from './campaign-event-projection';

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
   *
   * Issue #527: membership is re-checked reactively, not just at open. The
   * subscriber is tagged with its userId, and the stream completes (via
   * takeUntil) the instant a `membership.revoked` event for THIS user on THIS
   * campaign arrives — emitted by MembersService.remove(). A revocation for a
   * different user on the same campaign terminates only that user's stream;
   * unrelated subscribers keep flowing normally (and never even see the
   * revocation frame, which is filtered out of the data path as an internal
   * control signal). A reconnecting revoked user then hits requireMember and
   * gets a 403, so the drop is permanent until re-added.
   */
  @Sse()
  @ApiOperation({
    summary: 'Subscribe to campaign events (SSE)',
    description:
      'Requires campaign membership. Server-sent event stream of thin change signals ' +
      '(CampaignEvent JSON in `data`); clients refetch affected resources on receipt. ' +
      'Periodic `{"type":"ping"}` keepalives should be ignored. ' +
      'The stream closes automatically when the subscriber is removed from the campaign (issue #527); ' +
      'a reconnect then receives 403.',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({ status: 200, description: 'text/event-stream of CampaignEvent JSON.' })
  @ApiResponse({ status: 403, description: 'Not a member of this campaign.' })
  async stream(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @CurrentUser() user: RequestUser,
  ): Promise<Observable<MessageEvent>> {
    const role = await this.access.requireMember(user, campaignId);

    // Issue #527 / #867: complete the moment THIS user is revoked OR the campaign
    // is trashed. Applied with takeUntil to the WHOLE merged stream below (not
    // just the data path) so the heartbeat interval stops too — otherwise merge keeps
    // the SSE connection alive on keepalive pings after the data stream has ended,
    // defeating the teardown. The notifier subscribes to the same Subject the data
    // path reads, so it fires synchronously with the (filtered-out) control frame.
    const closed = this.events.streamFor(campaignId).pipe(
      filter(
        (event) =>
          (event.type === 'membership.revoked' && event.userId === user.id)
          || event.type === 'campaign.trashed',
      ),
    );

    // Drop membership.revoked / campaign.trashed frames from the data path — they
    // are internal termination signals, not a "refetch this" tick. (The web client's
    // isCampaignEvent guard accepts the variants, but no client handler acts on them
    // as data. We filter them out server-side so the wire stays clean.)
    const dataStream = this.events.streamFor(campaignId).pipe(
      filter((event) => event.type !== 'membership.revoked' && event.type !== 'campaign.trashed'),
      map((event) => {
        // Role redaction is enforced HERE, at the broadcast boundary (#572, #1552).
        // `projectCampaignEventForRole` fails closed: an unclassified frame type does not
        // compile, and does not reach the wire.
        return projectCampaignEventForRole(event as any, role);
      }),
      filter((event): event is NonNullable<typeof event> => event !== null),
      map((event): MessageEvent => ({ data: event })),
    );

    return merge(
      dataStream,
      interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ data: { type: 'ping' } }))),
    ).pipe(takeUntil(closed));
  }
}
