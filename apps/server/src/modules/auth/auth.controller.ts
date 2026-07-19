import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthStatus, Me } from '@campfire/schema';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { AuthService } from './auth.service';
import { SettingsService } from '../settings/settings.service';
import { SetupRequestDto, LoginRequestDto, PasswordChangeDto } from './auth.dto';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS, VERSION } from './auth.constants';

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_MS,
    secure: process.env.NODE_ENV === 'production',
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
  ) {}

  @Public()
  @Get('status')
  async status(): Promise<AuthStatus> {
    const [setupRequired, allowLocalLogin] = await Promise.all([
      this.auth.setupRequired(),
      this.settings.getAllowLocalLogin(),
    ]);
    return {
      setupRequired,
      localLoginEnabled: allowLocalLogin,
      oidcEnabled: false,
      version: VERSION,
    };
  }

  @Public()
  @Post('setup')
  async setup(@Body() body: SetupRequestDto, @Res({ passthrough: true }) res: Response): Promise<Me> {
    const { token, me } = await this.auth.setup(body);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
    return me;
  }

  @Public()
  @Post('login')
  async login(@Body() body: LoginRequestDto, @Res({ passthrough: true }) res: Response): Promise<Me> {
    const { token, me } = await this.auth.login(body);
    res.cookie(SESSION_COOKIE_NAME, token, cookieOptions());
    return me;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (token) {
      await this.auth.logout(token);
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  }
}

@ApiTags('auth')
@Controller('me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  async me(@CurrentUser() user: RequestUser): Promise<Me> {
    // dev:* header users have no DB row; synthesize a Me shape for them.
    if (user.id.startsWith('dev:')) {
      return {
        user: {
          id: 0,
          username: user.name,
          displayName: user.name,
          serverRole: user.serverRole,
          disabled: false,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        memberships: [],
      };
    }
    return this.auth.buildMe(Number(user.id));
  }

  @Post('password')
  @HttpCode(204)
  async changePassword(
    @Body() body: PasswordChangeDto,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
  ): Promise<void> {
    if (user.id.startsWith('dev:')) {
      throw new UnauthorizedException('Password change is not available for dev-auth users');
    }
    if (!body.currentPassword) {
      throw new BadRequestException('currentPassword is required');
    }
    const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    const currentTokenHash = token ? await this.auth.tokenHashFor(token) : '';
    await this.auth.changeOwnPassword(Number(user.id), body.currentPassword, body.newPassword, currentTokenHash);
  }
}
