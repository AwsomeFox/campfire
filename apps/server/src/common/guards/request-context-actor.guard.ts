import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { patchRequestContext } from '../request-context';
import { auditActor, type RequestUser } from '../user.types';

/**
 * Issue #684 — after SessionAuthGuard resolves `req.user`, stamp the audit actor
 * into AsyncLocalStorage so audit rows and structured logs correlate without
 * threading actor through every service call. Implemented as a guard (not an
 * interceptor) so @Sse() handlers keep correct 403/404 lifecycle gates.
 */
@Injectable()
export class RequestContextActorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    if (req.user) {
      patchRequestContext({ actor: auditActor(req.user) });
    }
    return true;
  }
}
