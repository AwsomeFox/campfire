import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { CampaignEventInput, CampaignEvent } from '@campfire/schema';
import { CampaignEventsService } from '../events/campaign-events.service';

/**
 * Pushes AI-DM narration events to the shared campaign stream (Issue #880).
 */
@Injectable()
export class AiDmStreamService {
  constructor(private readonly events: CampaignEventsService) {}

  emit(event: CampaignEventInput): void {
    this.events.emit(event);
  }

  streamFor(campaignId: number): Observable<CampaignEvent> {
    return this.events.streamFor(campaignId);
  }
}

