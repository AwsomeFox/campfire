import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
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
  @ApiOperation({ summary: 'List installed rule packs', description: 'Any authenticated user.' })
  @ApiResponse({ status: 200, description: 'Installed rule packs.' })
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
  @ApiOperation({ summary: 'Install (or incrementally update) a rule pack from Open5e', description: 'Server-admin only. Fetches spells/monsters/items/conditions from the Open5e API (or an override `url`, mainly for tests) and stores them as rule entries.' })
  @ApiResponse({ status: 201, description: 'Fresh install.' })
  @ApiResponse({ status: 200, description: 'Pack already existed; body reports `added`/`skippedExisting` entry counts.' })
  async install(@Body() body: RulePackInstallDto, @CurrentUser() user: RequestUser, @Res({ passthrough: true }) res: Response) {
    const result = await this.rules.installFromOpen5e(body, user);
    res.status('added' in result ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  @Delete('packs/:id')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Uninstall a rule pack', description: 'Server-admin only. Removes the pack and its entries.' })
  @ApiResponse({ status: 200, description: 'Uninstalled.' })
  async uninstall(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    await this.rules.uninstall(id, user);
    return { ok: true };
  }

  @Get('search')
  @ApiOperation({ summary: 'Search rule entries', description: 'Any authenticated user. Searches across all installed packs unless `pack` is given.' })
  @ApiQuery({ name: 'q', required: false, description: 'Free-text search against entry name/summary. Empty returns all (subject to type/pack filters).' })
  @ApiQuery({ name: 'type', required: false, enum: ['spell', 'monster', 'item', 'class', 'race', 'condition', 'section', 'other'], description: 'Filter to one entry type.' })
  @ApiQuery({ name: 'pack', required: false, description: 'Filter to one pack by slug.' })
  @ApiResponse({ status: 200, description: 'Matching rule entries.' })
  search(
    @Query('q') q: string | undefined,
    @Query('type') type: string | undefined,
    @Query('pack') pack: string | undefined,
  ) {
    return this.rules.search({ q: q ?? '', type: type as RuleEntryType | undefined, pack });
  }

  @Get('entries/:id')
  @ApiOperation({ summary: 'Get a rule entry', description: 'Any authenticated user.' })
  @ApiResponse({ status: 200, description: 'Rule entry.' })
  getEntry(@Param('id', ParseIntPipe) id: number) {
    return this.rules.getEntryOrThrow(id);
  }
}
