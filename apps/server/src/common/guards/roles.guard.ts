import { Injectable, type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '@campfire/schema';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { roleAtLeast, type RequestUser } from '../user.types';

/**
 * Enforces @Roles(minRole) on handlers/controllers.
 * Requires DevAuthGuard to have run first (req.user set).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const user = req.user;
    if (!user) throw new ForbiddenException('No user context');

    const ok = required.every((min) => roleAtLeast(user.role, min));
    if (!ok) {
      throw new ForbiddenException(`Requires role: ${required.join(', ')}`);
    }
    return true;
  }
}
