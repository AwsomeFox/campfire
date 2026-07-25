import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { auditActor } from '../user.types';
import type { RequestUser } from '../user.types';
import { getRequestContext, getRequestId, patchRequestContext } from '../request-context';
import { logRequest } from '../request-log';

/**
 * Issue #684 — structured REST access log with actor/latency/result. Runs after
 * guards so `req.user` is available; patches the AsyncLocalStorage context with
 * the audit actor string for downstream audit rows and MCP/provider logs.
 */
@Injectable()
export class RequestObservabilityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: RequestUser; requestId?: string }>();
    const res = http.getResponse<Response>();

    if (req.user) {
      patchRequestContext({ actor: auditActor(req.user) });
    }

    const startedAt = getRequestContext()?.startedAt ?? Date.now();
    const path = req.originalUrl || req.url || '';

    if (this.isOperationalProbe(path)) {
      return next.handle();
    }

    return next.handle().pipe(
      tap({
        next: () => this.emit(req, res, startedAt, 'ok'),
        error: () => this.emit(req, res, startedAt, 'error'),
      }),
    );
  }

  private isOperationalProbe(path: string): boolean {
    return path === '/healthz' || path === '/readyz' || path.startsWith('/healthz') || path.startsWith('/readyz');
  }

  private emit(
    req: Request & { user?: RequestUser; requestId?: string },
    res: Response,
    startedAt: number,
    result: 'ok' | 'error',
  ): void {
    const ctx = getRequestContext();
    const requestId = getRequestId() ?? req.requestId;
    if (!requestId) return;

    logRequest({
      requestId,
      transport: ctx?.transport ?? 'rest',
      result,
      latencyMs: Math.max(0, Date.now() - startedAt),
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      actor: ctx?.actor,
      campaignId: ctx?.campaignId,
      tool: ctx?.tool,
    });
  }
}
