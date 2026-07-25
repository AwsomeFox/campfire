import type { NextFunction, Request, Response } from 'express';
import { createRequestContext, runWithRequestContext, type RequestTransport } from './request-context';

function resolveTransport(req: Request): RequestTransport {
  const path = req.path || req.url || '';
  return path === '/mcp' || path.startsWith('/mcp') ? 'mcp' : 'rest';
}

/**
 * Express middleware (issue #684): mint/accept `X-Request-Id`, echo it on the
 * response, and bind an AsyncLocalStorage context for the rest of the request.
 * Replaces the inline middleware in main.ts / test-app.ts (issue #682).
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx = createRequestContext({
    inboundHeader: req.headers['x-request-id'],
    transport: resolveTransport(req),
  });
  (req as Request & { requestId?: string }).requestId = ctx.requestId;
  res.setHeader('X-Request-Id', ctx.requestId);
  runWithRequestContext(ctx, () => next());
}
