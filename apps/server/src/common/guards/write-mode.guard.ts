import { Injectable, type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PROPOSABLE_KEY, WRITE_MODE_EXEMPT_KEY } from '../decorators/proposable.decorator';
import type { RequestUser, TokenContext } from '../user.types';

/** HTTP methods that never mutate state — always allowed regardless of writeScope. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Server-side WRITE-MODE enforcement (issue #158), a global backstop that runs
 * after SessionAuthGuard has populated req.tokenContext.
 *
 * A token carries a `writeScope` independent of its read `scope`:
 *  - 'direct'  — allowed to mutate as before (subject to role checks downstream).
 *  - 'propose' — may ONLY reach @Proposable() write handlers, which coerce the
 *                mutation into a pending proposal (see requireWriteMode). Any other
 *                mutating endpoint (no proposal path — e.g. HP/XP adjustments,
 *                encounters, dice, campaign settings) is rejected: it can't offer
 *                the review guarantee, so the safe answer is to block it. The token
 *                can never write canon directly, whether or not it passes
 *                `?proposed=true`.
 *  - 'none'    — read-only: every mutating request is rejected.
 *
 * Requests with no tokenContext (session cookies, dev-auth) and 'direct' tokens
 * are unaffected — this guard only ever tightens propose/none tokens, so existing
 * behavior and tests are preserved.
 */
@Injectable()
export class WriteModeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { tokenContext?: TokenContext; user?: RequestUser }>();

    const tokenContext = req.tokenContext;
    if (!tokenContext) return true; // session cookie / dev-auth — not token-gated here.

    const writeScope = tokenContext.writeScope;
    if (writeScope === 'direct') return true; // default / back-compat: unchanged.

    // Safe (non-mutating) HTTP methods are always allowed — read authority is
    // governed by `scope`, not `writeScope`.
    if (READ_METHODS.has(req.method)) return true;

    // Account/self-management routes (e.g. minting or revoking one's own tokens)
    // opt out: they aren't campaign canon and are already escalation-safe (child
    // tokens are capped to the caller on every dimension, writeScope included).
    const exempt = this.reflector.getAllAndOverride<boolean>(WRITE_MODE_EXEMPT_KEY, [context.getHandler(), context.getClass()]);
    if (exempt) return true;

    if (writeScope === 'none') {
      throw new ForbiddenException('This token is read-only and cannot perform writes');
    }

    // writeScope === 'propose': permit only proposal-capable handlers (they route
    // the mutation into the DM's review queue). @Public routes (auth bootstrap
    // etc.) are not campaign writes and are left alone.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const proposable = this.reflector.getAllAndOverride<boolean>(PROPOSABLE_KEY, [context.getHandler(), context.getClass()]);
    if (proposable) return true;

    throw new ForbiddenException(
      'This token may only submit proposals; this endpoint has no proposal path and cannot be written to directly',
    );
  }
}
