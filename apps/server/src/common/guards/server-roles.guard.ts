import { Injectable, type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ServerRole } from '@campfire/schema';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SERVER_ROLES_KEY } from '../decorators/server-roles.decorator';
import type { RequestUser } from '../user.types';

/** Enforces @ServerRoles(...) — server-wide admin gating (users admin, settings). */
@Injectable()
export class ServerRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<ServerRole[] | undefined>(SERVER_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('No user context');

    // Only 'admin' is ever required in practice; dev:* header users always carry serverRole 'admin'.
    const ok = required.every((r) => (r === 'admin' ? user.serverRole === 'admin' : true));
    if (!ok) {
      throw new ForbiddenException(`Requires server role: ${required.join(', ')}`);
    }
    return true;
  }
}
