import { describe, it, expect } from '@jest/globals';
import { markHttpProjected, type HttpProjected } from '../../src/modules/ai-driver/grounding-projection.interceptor';
import type { AiDmTurnRunResult } from '../../src/modules/ai-driver/ai-driver.service';
import type { GroundingVerdict } from '../../src/modules/ai-driver/driver-grounding';

/**
 * Issue #1639 — role redaction of a grounding verdict is enforced by
 * `GroundingProjectionInterceptor`, a runtime property of `AiDriverController`
 * (`@UseInterceptors`, applied class-wide). Nothing in the TYPE SYSTEM stopped a future
 * player-callable handler from declaring a return type that carries a raw, unprojected
 * `GroundingVerdict` — the guarantee was a decorator someone had to remember, and #1632's
 * regression tests exist precisely because "remembering" is the weak part.
 *
 * `HttpProjected<T>` / `markHttpProjected` (grounding-projection.interceptor.ts) close
 * the TYPE-LEVEL half of that gap: the five player-callable turn handlers on
 * `AiDriverController` (`message`, `startSession`, `wrapUp`, `nudge`, `flag`) now declare
 * `Promise<HttpProjected<AiDmTurnRunResult>>`, and the brand key is a module-private
 * `unique symbol` that only `markHttpProjected` can produce a matching value for.
 *
 * THIS FILE IS THE COMPILE-LEVEL PROOF THE ISSUE ASKS FOR, NOT A RUNTIME ONE. Each
 * `@ts-expect-error` below asserts "the following line fails to type-check." If the brand
 * is ever weakened (the symbol accidentally exported, the field made optional, the
 * intersection dropped, …) so that a raw, unprojected value newly satisfies
 * `HttpProjected<T>`, the directive itself becomes an error — "unused '@ts-expect-error'
 * directive" — and `npx tsc --noEmit` / `ts-jest`'s own type-checking (this project does
 * not run Jest with `isolatedModules`, so ts-jest type-checks every file it transforms)
 * fails this SUITE, not just some assertion inside it. That is what makes this a
 * compile-level test rather than a behavioral one: it proves a property of the TYPES, and
 * would fail differently (a red suite that never gets to `it()`) than a broken runtime
 * assertion would.
 *
 * The #1632 runtime specs (removing the interceptor and observing 4 real leaks) remain
 * the behavioral backstop this does not replace — see the interceptor file's own comment
 * for exactly what this brand does and does not prove (it cannot detect the
 * `@UseInterceptors` line itself being removed, nor a brand-new handler that skips both
 * the branded return type and `markHttpProjected`).
 */
describe('GroundingProjectionInterceptor HTTP brand (#1639)', () => {
  const rawVerdict: GroundingVerdict = {
    status: 'clean',
    claims: [],
    supportedCount: 0,
    unsupportedCount: 0,
    provider: 'mock',
    model: 'mock-model',
    retrievals: [],
  };

  // Only the fields exercised by this spec are given real values; the rest of
  // `AiDmTurnRunResult`/`AiDmSeat` is irrelevant to a type-brand proof.
  const rawTurn = {
    narration: 'The door creaks open.',
    stopReason: 'end_turn',
    steps: 1,
    toolCalls: [],
    tokensUsed: 10,
    tokenBudget: 1000,
    budgetRemaining: 990,
    seat: {},
    grounding: rawVerdict,
  } as unknown as AiDmTurnRunResult;

  it('markHttpProjected is a runtime no-op — identity, not a second redaction pass', () => {
    const projected = markHttpProjected(rawTurn);
    // Same object reference: no copy, no rewrite. The interceptor is still the only thing
    // that ever touches the actual `grounding` payload.
    expect(projected).toBe(rawTurn);
    expect(projected.grounding).toBe(rawVerdict);
  });

  it('compiles: a value produced by markHttpProjected satisfies HttpProjected<T>', () => {
    const projected: HttpProjected<AiDmTurnRunResult> = markHttpProjected(rawTurn);
    expect(projected.narration).toBe('The door creaks open.');
  });

  it('does NOT compile: a raw AiDmTurnRunResult cannot be assigned to HttpProjected<AiDmTurnRunResult> directly', () => {
    // @ts-expect-error — the brand key ([HTTP_PROJECTED]) is a module-private `unique
    // symbol` never exported from grounding-projection.interceptor.ts, so no value
    // declared with the plain `AiDmTurnRunResult` type can structurally satisfy
    // `HttpProjected<AiDmTurnRunResult>`. This is exactly the shape of the bug this brand
    // exists to catch: a handler returning the driver's raw turn result without routing
    // it through `markHttpProjected` first.
    const illegal: HttpProjected<AiDmTurnRunResult> = rawTurn;
    expect(illegal).toBeDefined();
  });

  it('does NOT compile: an inline object literal shaped like a turn result is rejected too, not just a pre-typed variable', () => {
    // @ts-expect-error — same guarantee, exercised via a fresh object literal (spread of
    // an already-`AiDmTurnRunResult`-typed value) so structural widening on the literal
    // can't smuggle the brand in either. A fresh literal has no way to name the
    // module-private symbol key.
    const illegal: HttpProjected<AiDmTurnRunResult> = { ...rawTurn };
    expect(illegal).toBeDefined();
  });

  it('does NOT compile: casting a raw verdict straight into the branded field is rejected without markHttpProjected', () => {
    // @ts-expect-error — mirrors what a future handler would try if it wanted to keep the
    // narrower "just brand the grounding field" shape instead of the whole result; still
    // requires markHttpProjected, there is no field-level shortcut around it.
    const illegal: { grounding: HttpProjected<GroundingVerdict> } = { grounding: rawVerdict };
    expect(illegal).toBeDefined();
  });
});
