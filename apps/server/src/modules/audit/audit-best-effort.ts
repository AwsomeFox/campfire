/**
 * Best-effort audit write (issue #1581).
 *
 * The operation this records has ALREADY COMMITTED by the time this runs, so a failure
 * writing the audit row must never look like the operation itself failed — an operator
 * who sees `failed` retries a change that already landed, which for a non-idempotent
 * write is how it gets applied twice. Logs the failure loudly (an unaudited action is
 * itself an incident, never silently swallowed) and returns a short note the caller can
 * fold into an operator-facing result, so the trail's own gap is visible too.
 *
 * Consolidates three independent copies of this exact try/catch/log shape that #1546
 * introduced by hand — the bulk per-item write, the bulk summary write, and the
 * export-decision mirrors in `admin-catalog.service.ts` — which had already started to
 * disagree in wording and in whether a failure note reached the caller at all. `describe`
 * is the one thing each call site genuinely varies: what to say happened. Everything
 * else (attempt, catch, log at error level with the stack, never rethrow) is now written
 * once.
 *
 * Deliberately takes an already-built `AuditService` + `Logger` rather than being a
 * method on `AuditService` itself: the log MESSAGE is caller-context (which operation,
 * which id, which outcome), and `AuditService` has no business knowing any of that.
 *
 * `audit` is typed as `Pick<AuditService, 'log'>` rather than the full class (issue
 * #1527): this function is a plain function, not NestJS-DI-constructed, so narrowing
 * costs nothing here and buys a real, two-way guarantee a bare `Pick`-typed *double*
 * cannot on its own — if this function starts calling a second `AuditService` method,
 * that call fails to compile HERE, forcing the Pick list to widen; once widened, every
 * caller (real `AuditService` instances still satisfy it structurally) and every test
 * double must supply the new method too.
 */
import type { Logger } from '@nestjs/common';
import type { AuditLogParams, AuditService } from './audit.service';

export async function auditBestEffort(
  audit: Pick<AuditService, 'log'>,
  logger: Logger,
  entry: AuditLogParams,
  describe: (err: unknown) => string,
): Promise<string | null> {
  try {
    await audit.log(entry);
    return null;
  } catch (err) {
    logger.error(describe(err), err instanceof Error ? err.stack : String(err));
    return 'audit row could not be written';
  }
}
