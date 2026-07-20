import { SetMetadata } from '@nestjs/common';

export const PROPOSABLE_KEY = 'campfire:proposable';

/**
 * Marks a write handler as proposal-capable: it inspects requireWriteMode() and
 * will coerce a `propose`-mode token's mutation into a pending proposal instead
 * of a direct write (issue #158).
 *
 * The WriteModeGuard reads this metadata: a `propose`-mode token is allowed
 * through to a @Proposable() handler (which routes it to the proposal queue) but
 * is REJECTED on any other mutating endpoint — one with no proposal path can't
 * offer the review guarantee, so the safe answer is to block it. Handlers that
 * carry this decorator MUST call requireWriteMode() to actually perform the
 * coercion; the guard only enforces the "propose token can't reach a
 * non-proposable write" half.
 */
export const Proposable = () => SetMetadata(PROPOSABLE_KEY, true);

export const WRITE_MODE_EXEMPT_KEY = 'campfire:writeModeExempt';

/**
 * Exempts a write handler from WriteModeGuard's propose/none tightening — for
 * routes that are account/self-management rather than campaign canon (e.g.
 * minting or revoking one's own API tokens). Minting is already escalation-safe:
 * a child token is capped to the calling token on every dimension, writeScope
 * included (TokensService.create), so even a read-only ('none') token can only
 * ever spawn an equally-restricted child. Read scope still governs what these
 * routes can see; this only stops the write-mode guard from 403-ing them.
 */
export const WriteModeExempt = () => SetMetadata(WRITE_MODE_EXEMPT_KEY, true);
