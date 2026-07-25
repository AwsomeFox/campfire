import type { NextFunction, Request, Response } from 'express';
import { createRequestContext, runWithRequestContext, type RequestTransport } from './request-context';
import { logRequest } from './request-log';
import { auditActor, type RequestUser } from './user.types';

function resolveTransport(req: Request): RequestTransport {
  const path = req.path || req.url || '';
  return path === '/mcp' || path.startsWith('/mcp') ? 'mcp' : 'rest';
}

function isOperationalProbe(path: string): boolean {
  return path === '/healthz' || path === '/readyz' || path.startsWith('/healthz') || path.startsWith('/readyz');
}

function isSseRequest(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/event-stream');
}

/**
 * Express middleware (issue #684): mint/accept `X-Request-Id`, echo it on the
 * response, bind an AsyncLocalStorage context, and emit structured REST access
 * logs when the response finishes. SSE streams and MCP tool calls are excluded
 * (MCP logs per-tool; SSE must not register finish handlers that interfere with
 * Nest's @Sse() lifecycle).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx = createRequestContext({
    inboundHeader: req.headers['x-request-id'],
    transport: resolveTransport(req),
  });
  (req as Request & { requestId?: string }).requestId = ctx.requestId;
  res.setHeader('X-Request-Id', ctx.requestId);

  const path = req.originalUrl || req.url || '';
  const shouldLogRest = !isOperationalProbe(path) && !isSseRequest(req) && ctx.transport === 'rest';

  if (shouldLogRest) {
    res.once('finish', () => {
      const user = (req as Request & { user?: RequestUser }).user;
      logRequest({
        requestId: ctx.requestId,
        transport: 'rest',
        result: res.statusCode >= 400 ? 'error' : 'ok',
        latencyMs: Math.max(0, Date.now() - ctx.startedAt),
        method: req.method,
        path,
        status: res.statusCode,
        actor: user ? auditActor(user) : undefined,
      });
    });
  }

  runWithRequestContext(ctx, () => next());
}
