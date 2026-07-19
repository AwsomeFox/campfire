import { Injectable, type CanActivate, type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Role } from '@campfire/schema';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { RequestUser } from '../user.types';
import { AuthService } from '../../modules/auth/auth.service';
import { SESSION_COOKIE_NAME } from '../../modules/auth/auth.constants';

/**
 * Resolves req.user from, in order:
 *  (a) the session cookie (real local-auth users), else
 *  (b) if env DEV_AUTH=1: legacy x-dev-user/x-dev-role headers — synthetic
 *      user id `dev:<name>`, keeps all pre-auth e2e tests passing, else
 *  (c) unauthenticated -> 401, unless the route is @Public().
 *
 * Replaces the old header-only DevAuthGuard. Kept as a single global guard
 * (APP_GUARD) so every route (including @Public ones) gets req.user
 * populated when resolvable, harmlessly.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();

    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (token) {
      const user = await this.authService.resolveSessionUser(token);
      if (user) {
        req.user = user;
        return true;
      }
      // Invalid/expired cookie: fall through to dev-auth (if enabled) or 401.
    }

    if (process.env.DEV_AUTH === '1') {
      const rawRole = (req.headers['x-dev-role'] as string | undefined)?.toLowerCase();
      const parsedRole = Role.safeParse(rawRole);
      const devRole = parsedRole.success ? parsedRole.data : 'dm';

      const rawName = (req.headers['x-dev-user'] as string | undefined)?.trim() || 'dev-user';
      req.user = {
        id: `dev:${rawName}`,
        name: rawName,
        serverRole: 'admin',
        devRole,
      };
      return true;
    }

    if (isPublic) return true;

    throw new UnauthorizedException('Authentication required');
  }
}
