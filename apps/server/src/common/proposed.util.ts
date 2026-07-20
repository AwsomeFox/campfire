import { ForbiddenException } from '@nestjs/common';
import type { RequestUser } from './user.types';

/** `?proposed=true` (or `1`) query param check for the propose-instead-of-write flow. */
export function isProposed(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * Server-enforced write-mode gate for every proposal-capable write controller
 * (issue #158). Given the authenticated request user and the caller-supplied
 * `?proposed=` query flag, returns whether the write must be routed through the
 * proposal queue (true) or applied directly (false).
 *
 * The decision is driven by the token's server-side `writeScope`, NOT just the
 * voluntary flag:
 *  - writeScope 'none'    → 403: the token is read-only, no write (direct or
 *                           proposed) is allowed.
 *  - writeScope 'propose' → FORCED to propose (returns true) regardless of the
 *                           `?proposed=` flag — the token can never write canon
 *                           directly, even if it omits the flag.
 *  - writeScope 'direct'  → honors the flag (isProposed), i.e. the pre-#158
 *                           behavior — the opt-in proposal path.
 *  - no tokenContext (session cookie / dev-auth) → honors the flag, unchanged.
 *
 * Centralizing here (plus the WriteModeGuard backstop for non-proposable write
 * endpoints) keeps every write controller honoring the token's write authority
 * without per-controller drift.
 */
export function requireWriteMode(user: RequestUser, proposed: unknown): boolean {
  const writeScope = user.tokenContext?.writeScope;
  if (writeScope === 'none') {
    throw new ForbiddenException('This token is read-only and cannot perform writes');
  }
  if (writeScope === 'propose') return true; // forced down the proposal path — flag ignored
  // REST passes the raw `?proposed=` query string; MCP passes a boolean tool arg
  // (typed `unknown` off the JSON-RPC payload). Both collapse to "did the caller
  // ask to propose?".
  if (typeof proposed === 'boolean') return proposed;
  return isProposed(typeof proposed === 'string' ? proposed : undefined);
}

/**
 * Guard for a write with NO proposal path (direct-only mutations: HP/XP tweaks,
 * combat, dice, campaign settings, etc.). A 'propose'-mode token can't route
 * these through review, so — like the WriteModeGuard does for the equivalent REST
 * endpoints — the safe answer is to reject rather than let the write land
 * directly. A 'none' token is rejected too; 'direct' tokens and sessions pass.
 * Used on the MCP surface, where tools call services directly (bypassing the
 * HTTP WriteModeGuard) and so must enforce write-mode themselves (issue #158).
 */
export function assertDirectWriteAllowed(user: RequestUser): void {
  const writeScope = user.tokenContext?.writeScope;
  if (writeScope === 'none') {
    throw new ForbiddenException('This token is read-only and cannot perform writes');
  }
  if (writeScope === 'propose') {
    throw new ForbiddenException(
      'This token may only submit proposals; this action has no proposal path and cannot be performed directly',
    );
  }
}
