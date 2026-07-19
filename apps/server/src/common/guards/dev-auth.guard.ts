import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Role } from '@campfire/schema';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { RequestUser } from '../user.types';

/**
 * Dev-mode "auth": trusts x-dev-role / x-dev-user headers.
 * Attaches req.user = { id, name, role }. No OIDC yet (see README).
 */
@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();

    const rawRole = (req.headers['x-dev-role'] as string | undefined)?.toLowerCase();
    const parsedRole = Role.safeParse(rawRole);
    const role = parsedRole.success ? parsedRole.data : 'dm';

    const userId = (req.headers['x-dev-user'] as string | undefined)?.trim() || 'dev-user';

    req.user = { id: userId, name: userId, role };

    // Even public routes get req.user attached (harmless), but we always allow.
    void isPublic;
    return true;
  }
}
