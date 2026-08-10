import { Controller, Param, ParseIntPipe, Req, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiProduces } from '@nestjs/swagger';
import { fromEvent, interval, merge, map, type Observable } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { CampaignEventsService } from './campaign-events.service';
import { projectCampaignEventForRole } from './campaign-event-projection';

/**
 * Keepalive cadence. Long enough to be negligible traffic, short enough that
 * typical reverse-proxy idle timeouts (usually 60s+) never cut a quiet stream.
 *
 * Exported and mutable so the #2126 regression test can shrink the interval to
 * exercise the heartbeat-write-after-close race without waiting 25 seconds.
 */
export let HEARTBEAT_MS = 25_000;

/** Test-only: shrink the SSE heartbeat interval so the disconnect race is exercisable. */
export function setHeartbeatMsForTests(ms: number): void {
  HEARTBEAT_MS = ms;
}

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
    @Req() req: Request,
  ): Promise<Observable<MessageEvent>> {
    const role = await this.access.requireMember(user, campaignId);

    // Issue #527 / #867: complete immediately when THIS user is revoked OR the campaign is trashed.
    const closed = this.events.streamFor(campaignId).pipe(
      filter(
        (event) =>
          (event.type === 'membership.revoked' && event.userId === user.id) ||
          event.type === 'campaign.trashed',
      ),
    );

    // Issue #2126: complete the stream the instant the HTTP client disconnects. Nest's
    // @Sse() framework registers its own `request.on('close')` to unsubscribe and end
    // the response, but there is a TOCTOU window between the underlying socket closing
    // (TCP RST received, response.destroyed=true) and the close event firing in the
    // next tick. During that window the heartbeat interval below can still emit a ping
    // into the merged pipe, and the framework's concatMap writes it to the destroyed
    // response — an unhandled 'error' event that silently kills the process (there is
    // no process-level uncaughtException handler). Listening to BOTH the request's
    // 'close' and 'aborted' events (and the underlying socket's 'close' if present)
    // via takeUntil ensures the interval stops before that write can happen. This
    // mirrors the res.once('close') guard already used by the backup/export streaming
    // controllers and covers the earlier-aborted path that 'close' alone can miss.
    const disconnectSignals: Observable<unknown>[] = [fromEvent(req, 'close'), fromEvent(req, 'aborted')];
    const rawSocket = (req as Request & { socket?: NodeJS.EventEmitter }).socket;
    if (rawSocket) disconnectSignals.push(fromEvent(rawSocket, 'close'));
    const clientDisconnected = merge(...disconnectSignals);

    // Drop membership.revoked / campaign.trashed frames from the data path — they
    // are internal termination signals, not a "refetch this" tick. (The web client's
    // isCampaignEvent guard accepts the variants, but no client handler acts on them
    // as data. We filter them out server-side so the wire stays clean.)
    const dataStream = this.events.streamFor(campaignId, { userId: user.id, role }).pipe(
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
    ).pipe(takeUntil(merge(closed, clientDisconnected)));
  }
}
