import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiErrorEnvelope,
  buildRestEnvelope,
  resolveRequestIdFromHeader,
} from '../api-error.envelope';

/**
 * Issue #682 — the single global REST exception filter.
 *
 * Shapes EVERY exception that escapes a controller into the published
 * Problem Details-style envelope (see `api-error.envelope.ts`). It also:
 *
 *   - generates / accepts a per-request id (`X-Request-Id` header) and echoes
 *     it on the response so an integrator's support tickets carry a stable
 *     correlation token;
 *   - logs uncaught 5xx with the request id so an operator can pivot from a
 *     user-reported `requestId` to the exact stack trace;
 *   - sanitizes 5xx messages on the wire — never trust an internal
 *     `Error.message` (which often carries DB/connection/secret fragments);
 *   - leaves HttpExceptions free to set their own status code and detail.
 *
 * Registered as a global filter via `app.useGlobalFilters()` in `main.ts`
 * `configureApp()` and `test/test-app.ts`'s `createTestApp()`.
 *
 * Note: this filter ONLY shapes responses for the REST surface. The MCP
 * transport (`POST /mcp`) is a stateless JSON-RPC handler that owns its own
 * response shape — its `fail()` (in `mcp-tools.ts`) calls into the same
 * envelope helper, so REST and MCP publish the same `code`/`message`/
 * `errors[]`/`requestId` vocabulary without either side reaching into the
 * other's transport.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();

    // Reuse a requestId that earlier middleware may have stamped onto req, else
    // accept an inbound X-Request-Id header, else mint one. The single read
    // means an inbound header is preserved end-to-end even if other middleware
    // also reads req.id.
    const requestId =
      req.requestId ?? resolveRequestIdFromHeader(req.headers['x-request-id']);
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const instance = req.originalUrl || req.url;

    // Health-check probes (/healthz, /readyz) are operational endpoints, not
    // API surface. Their bodies are consumed by Docker/k8s probes that only
    // care about the status code plus a small `{ ok, version, error }` shape
    // the probe tooling already understands — wrapping them in the Problem
    // Details envelope would drop `version` (useful for "which build is
    // broken?") and serve no integrator. Let their thrown bodies pass through.
    const url = req.url || '';
    if (url === '/healthz' || url === '/readyz' || url.startsWith('/healthz') || url.startsWith('/readyz')) {
      const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
      const body = exception instanceof HttpException ? exception.getResponse() : { message: 'Internal server error' };
      res.status(status).json(typeof body === 'string' ? { message: body } : body);
      return;
    }

    const envelope = buildRestEnvelope({ err: exception, requestId, instance });

    // Log uncaught 5xx — the request id is the integrator-facing correlation
    // token, so include it in every log line an operator will pivot from.
    // 4xx are NOT logged: they are expected domain errors (404 on a missing
    // row, 403 on a forbidden route) and logging each would bury real signals.
    if (envelope.status >= 500) {
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(
        `requestId=${requestId} status=${envelope.status} ${req.method} ${instance}`,
        stack,
      );
    }

    // Prefer the normalized envelope status (covers express.json entity.too.large
    // and other middleware-thrown errors with a status property). HttpException
    // status is already mirrored in the envelope.
    const status = envelope.status;

    // RFC 9457 advertising: tell integrators this is application/problem+json.
    // (Swagger documents application/json on the wire shape; many Problem Details
    // clients sniff the content-type and prefer it when present, but the body
    // is still consumable as plain JSON. Keeping application/problem+json here
    // is the standard's recommendation and is silently backward-compatible.)
    res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    res.status(status).json(envelope satisfies ApiErrorEnvelope);
  }
}
