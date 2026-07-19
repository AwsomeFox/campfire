import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import type { RuleEntryType } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import type { RequestUser } from '../../common/user.types';
import { RulesService } from './rules.service';
import { RulePackInstallDto } from './rules.dto';

/**
 * Rule packs (Compendium backend). Reads (list packs, search, entry fetch)
 * are open to any authenticated user — the Compendium screen is available to
 * players and DMs alike. Install/uninstall are server-admin only: packs are
 * server-wide, not per-campaign, so only a server admin can add/remove them
 * (mirrors the "Server admin → Rule systems" design screen).
 */
@ApiTags('rules')
@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('packs')
  listPacks() {
    return this.rules.listPacks();
  }

  /**
   * 201 for a fresh install; 200 when the pack already existed and this call added
   * (possibly zero) new entries incrementally — see RulesService.installFromOpen5e.
   * The response body always distinguishes the two: incremental responses carry
   * `added`/`skippedExisting`, a fresh install's body doesn't.
   */
  @Post('packs/install')
  @ServerRoles('admin')
  async install(@Body() body: RulePackInstallDto, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const result = await this.rules.installFromOpen5e(body, user);
    res.status('added' in result ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Delete('packs/:id')
  @ServerRoles('admin')
  async uninstall(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.rules.uninstall(id, user);
    return { ok: true };
  }

  @Get('search')
  search(
    @Query('q') q: string | undefined,
    @Query('type') type: string | undefined,
    @Query('pack') pack: string | undefined,
  ) {
    return this.rules.search({ q: q ?? '', type: type as RuleEntryType | undefined, pack });
  }

  @Get('entries/:id')
  getEntry(@Param('id', ParseIntPipe) id: number) {
    return this.rules.getEntryOrThrow(id);
  }
}
