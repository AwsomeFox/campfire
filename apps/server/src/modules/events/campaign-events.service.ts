import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { CampaignEvent, CampaignEventInput } from '@campfire/schema';
import { nowIso } from '../../common/time';

/**
 * In-process pub/sub for per-campaign real-time events (issue #4).
 *
 * Single-instance deploy — one Subject fanned out to every open SSE connection
 * is all that's needed; no cross-node transport. Domain services call emit()
 * from their write paths; the SSE controller subscribes via streamFor().
 *
 * Events are deliberately thin (type + ids, no entity payloads): subscribers
 * refetch through the normal permission-checked REST reads, so the stream can
 * never leak fields a member wasn't allowed to see.
 */
@Injectable()
export class CampaignEventsService {
  private readonly subject = new Subject<CampaignEvent>();

  /**
   * Accepts a single CampaignEvent variant minus its `at` timestamp (see
   * CampaignEventInput — distributive so a caller passing `{type, campaignId,
   * encounterId}` with `type` as a subset of the literals still type-checks).
   * The `at` is stamped here so emitters can't forge or skew it. The spread
   * preserves the caller's variant discriminant, and the `satisfies` check
   * proves the stamped object still conforms to the union — no `as` cast that
   * could silently bypass the compiler if the schema ever changes.
   */
  emit(event: CampaignEventInput): void {
    const stamped = { ...event, at: nowIso() } satisfies CampaignEvent;
    this.subject.next(stamped);
  }

  streamFor(campaignId: number): Observable<CampaignEvent> {
    return this.subject.asObservable().pipe(filter((event) => event.campaignId === campaignId));
  }
}
