import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, concatMap, from, of } from 'rxjs';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { projectGroundingVerdictForRole, type GroundingVerdict } from './driver-grounding';
import type { RequestUser } from '../../common/user.types';

/**
 * Redact DM-only grounding from EVERY AI-driver response, at the controller boundary (#1043).
 *
 * WHY THIS IS AN INTERCEPTOR AND NOT A FOURTH CALL TO `projectGroundingVerdictForRole`.
 *
 * A turn result carries `grounding`, and `grounding.retrievals` lists every entity id the turn
 * read — whether or not the model cited any of them. On a player-callable endpoint that is a
 * direct dump of the DM's hidden prep: a concealed NPC, an unrevealed quest. `POST /ai-dm/message`
 * has projected for the reading role since #577. `POST /ai-dm/start-session` shipped without it,
 * because the rule lived in one call site and a new player-callable turn endpoint had no reason
 * to know the rule existed. That is the defect: the guarantee was per-handler, so it held only
 * for handlers whose author remembered it, and a greeting — the turn most likely to touch
 * concealed material, because recapping is what it is for — was the one that forgot.
 *
 * Projecting at the boundary makes the guarantee a property of the CONTROLLER rather than of each
 * method. There is no longer anything for a future endpoint to omit: a handler cannot return an
 * unprojected verdict from this controller, because it does not get to decide.
 *
 * FAIL-SAFE BY CONSTRUCTION. `projectGroundingVerdictForRole` returns the verdict verbatim for
 * exactly one role — `dm` — and redacts for everything else. So every way this can go wrong
 * (unreadable campaign id, absent user, a role lookup that returns null) resolves to a role that
 * is NOT `dm`, and therefore to redaction. The failure mode is showing a DM too little, never
 * showing a player too much.
 *
 * `effectiveRole` is the non-throwing lookup deliberately: this runs AFTER the handler, so the
 * turn has already executed, metered tokens and broadcast its narration. A second authorization
 * assertion here could throw away a real result the table has already seen.
 *
 * Idempotent, so it composes with anything that already projected: a redacted citation has had
 * `dmOnly` stripped, and the retrievals filter is a no-op on an already-filtered list.
 */
@Injectable()
export class GroundingProjectionInterceptor implements NestInterceptor {
  constructor(private readonly access: CampaignAccessService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ params?: Record<string, string>; user?: RequestUser }>();
    const campaignId = Number(req.params?.id);
    const user = req.user;

    // `concatMap` + a SYNCHRONOUS `of` on the pass-through, deliberately.
    //
    // This controller also serves `@Sse('stream')`, whose handler returns a long-lived Observable
    // of many MessageEvents rather than one body. `switchMap` would UNSUBSCRIBE the previous inner
    // observable each time a new frame arrived, so wrapping every frame in a promise would drop
    // any event overtaken before its microtask resolved — silently losing narration frames on a
    // busy stream. `concatMap` never cancels and preserves order, and returning `of(body)` keeps
    // the non-verdict path synchronous so stream frames are not deferred at all.
    return next.handle().pipe(
      concatMap((body) => {
        const verdict = extractVerdict(body);
        // Nothing shaped like a turn verdict — every other response passes through untouched,
        // including every SSE frame and GET /ai-dm/grounding, whose array its handler projects.
        if (verdict === null) return of(body);
        return from(this.projectBody(body as Record<string, unknown>, verdict, campaignId, user));
      }),
    );
  }

  private async projectBody(
    body: Record<string, unknown>,
    verdict: GroundingVerdict,
    campaignId: number,
    user: RequestUser | undefined,
  ): Promise<unknown> {
    // Any failure to establish "this reader is the DM" must land on redaction, never on trust.
    let role = 'viewer';
    if (user && Number.isInteger(campaignId)) {
      try {
        role = (await this.access.effectiveRole(user, campaignId)) ?? 'viewer';
      } catch {
        role = 'viewer';
      }
    }
    return { ...body, grounding: projectGroundingVerdictForRole(verdict, role) };
  }
}

/** The response body's grounding verdict, or null when the body does not carry one. */
function extractVerdict(body: unknown): GroundingVerdict | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const grounding = (body as { grounding?: unknown }).grounding;
  if (typeof grounding !== 'object' || grounding === null || Array.isArray(grounding)) return null;
  // Structural check, not a cast of convenience: `retrievals` and `claims` are the two arrays the
  // projection actually rewrites, and a body without them is not a verdict.
  const v = grounding as { claims?: unknown; retrievals?: unknown };
  if (!Array.isArray(v.claims) || !Array.isArray(v.retrievals)) return null;
  return grounding as GroundingVerdict;
}
