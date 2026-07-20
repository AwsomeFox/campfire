import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { CampaignEvent } from '@campfire/schema';
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

  emit(event: Omit<CampaignEvent, 'at'>): void {
    this.subject.next({ ...event, at: nowIso() });
  }

  streamFor(campaignId: number): Observable<CampaignEvent> {
    return this.subject.asObservable().pipe(filter((event) => event.campaignId === campaignId));
  }
}
