import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import { nowIso } from '../../common/time';

/**
 * One AI-DM narration/turn event pushed to every subscriber of a campaign's driver
 * stream (GET /campaigns/:id/ai-dm/stream). Deliberately thin and non-secret:
 *
 *  - `narration.delta` carries a token-by-token text chunk as the model streams it —
 *    this is what makes the DM "type" live to every player at the table.
 *  - `narration.message` is the fully-aggregated narration for one step (so a client
 *    that missed deltas, or a late joiner, still gets the whole line).
 *  - `tool` is an id-only signal that the AI invoked a Campfire tool (name + whether
 *    it errored + whether it was routed to the proposal queue) — clients refetch the
 *    affected resource through the normal permission-checked REST reads, exactly like
 *    the encounter SSE channel, so nothing DM-only can leak through the stream.
 *  - `turn.start` / `turn.end` bracket a turn with its stop reason + budget snapshot.
 */
export type AiDmStreamEvent =
  | { type: 'turn.start'; campaignId: number; at: string }
  | { type: 'narration.delta'; campaignId: number; text: string; at: string }
  | { type: 'narration.message'; campaignId: number; text: string; at: string }
  | { type: 'tool'; campaignId: number; name: string; isError: boolean; proposed: boolean; at: string }
  | {
      type: 'turn.end';
      campaignId: number;
      stopReason: string;
      steps: number;
      tokensUsed: number;
      budgetRemaining: number;
      at: string;
    }
  // Stuck ladder (#314). `stuck` fires when detection trips (repeated tool errors, budget
  // exhaustion, max-steps-without-progress, empty narration, a loop, or a raised dispute) and
  // moves the seat to `awaiting_players`; `recovered` fires when a lever gets it running again;
  // `state` announces any other session-state transition (pause, human takeover, handback);
  // `vote` and `takeover` narrate the player levers. All are thin signals — clients refetch
  // GET /ai-dm/session for the authoritative state, exactly like the `tool` signal.
  | { type: 'stuck'; campaignId: number; reason: string; detail: string; state: string; levers: string[]; at: string }
  | { type: 'recovered'; campaignId: number; state: string; at: string }
  | { type: 'state'; campaignId: number; state: string; at: string }
  | { type: 'vote'; campaignId: number; action: string; kind: string; outcome?: string; at: string }
  | { type: 'takeover'; campaignId: number; action: string; memberId: string; at: string }
  // #557 — a DM granted or revoked a narrowly-scoped secret-read approval (the seat may now
  // read ONE secret entity under the DM principal). Thin signal: clients refetch GET
  // /ai-dm/session for the authoritative approval list.
  | { type: 'secret-approval'; campaignId: number; action: 'granted' | 'revoked'; tool: string; entityId: number; at: string };

/**
 * In-process pub/sub for the AI DM driver's narration stream (#312), modelled on the
 * existing CampaignEventsService (#4): a single Subject fanned out to every open SSE
 * connection on a single-instance deploy. Kept separate from the encounter event
 * channel so narration deltas (a high-frequency, AI-only stream) never mix with the
 * thin entity-invalidation signals, and so the CampaignEvent schema stays untouched.
 */
/** Distributive Omit so each union member keeps its own discriminated shape. */
type WithoutAt<T> = T extends unknown ? Omit<T, 'at'> : never;

@Injectable()
export class AiDmStreamService {
  private readonly subject = new Subject<AiDmStreamEvent>();

  emit(event: WithoutAt<AiDmStreamEvent>): void {
    this.subject.next({ ...event, at: nowIso() } as AiDmStreamEvent);
  }

  streamFor(campaignId: number): Observable<AiDmStreamEvent> {
    return this.subject.asObservable().pipe(filter((event) => event.campaignId === campaignId));
  }
}
