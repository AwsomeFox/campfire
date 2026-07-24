import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { listRulePackSources, type RuleEntryType } from '@campfire/schema';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { type RequestUser } from '../../common/user.types';
import { RulesService } from './rules.service';
import { RulePackInstallDto, RulePackUploadDto, RuleEntryUpdateDto } from './rules.dto';

/**
 * Rule packs (Compendium backend). Reads (list packs, search, entry fetch, install-job
 * status) are open to any authenticated user — the Compendium screen is available to
 * players and DMs alike.
 *
 * Every mutation (install, upload, entry icon override, uninstall) is server-admin only
 * (issue #736): rule packs are SERVER-WIDE, so installing, uploading, or uninstalling one
 * affects every campaign on the server — not just the caller's. Previously a DM of any
 * campaign could mutate these global packs (issue #20); that let one campaign's DM change
 * content every other campaign sees. Mutations are now gated on real server-admin power
 * via @ServerRoles('admin') (the same check uninstall already used), so a scope-capped PAT
 * owned by an admin cannot inherit that power either.
 *
 * Install runs as a non-blocking background job — POST returns 202 with a job the UI polls
 * (issue #20); the gate is enforced before the job is enqueued.
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
   * Honesty metadata for every install source (issue #346): whether each system has a real
   * open source wired (`sourceKind: 'api'`, installs with no `url`) or has none and must be
   * uploaded (`sourceKind: 'manual-upload'`). The install picker (#347) uses this to offer a
   * one-click import where possible and steer to the upload path otherwise — rather than
   * showing a source that would fail. Open to any authenticated user (read-only).
   */
  @Get('sources')
  @ApiOperation({
    summary: 'List rule-pack install sources with honesty metadata',
    description: "Any authenticated user. Each source reports its sourceKind ('api' | 'manual-upload'), whether it installs without a `url`, its license, and (for manual-upload) a documented candidate source.",
  })
  @ApiResponse({ status: 200, description: 'Install sources and their metadata.' })
  listSources() {
    return listRulePackSources();
  }

  /**
   * Kicks off an open-content import as a background job and returns 202 with the job (issue
   * #20). The UI polls GET packs/install-jobs/:id for per-section progress and the final
   * result; `outcome` on the completed job is 'created' (fresh) or 'updated' (incremental
   * add, with `added`/`skippedExisting` counts).
   */
  @Post('packs/install')
  @ServerRoles('admin')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Install a rule pack from an open source (background job)',
    description:
      "Server admin only (packs are server-wide). `source` selects the importer: 'open5e' (D&D 5e, default), " +
      "'pf2e' (Pathfinder 2e), 'sf2e' (Starfinder 2e), 'pf1e' (Pathfinder 1e), 'starfinder', 'archmage' (13th Age), 'open-legend', " +
      "or 'osr' (retroclones — pass `system` to pick the variant, e.g. 'basic-fantasy'). Sections are " +
      'validated per-source (a foreign section is rejected 400). open5e/pf2e/sf2e/open-legend have a wired live ' +
      'open source and install with no `url`; pf1e/starfinder/archmage/osr have no open source (#346, see ' +
      'GET /rules/sources) — install those via POST /rules/packs/upload or pass an explicit `url`. Returns 202 with a job to poll.',
  })
  @ApiResponse({ status: 202, description: 'Install job accepted; poll packs/install-jobs/:id.' })
  @ApiResponse({ status: 400, description: 'Rejected — a section invalid for the source, or a required `url` was missing.' })
  async install(@Body() body: RulePackInstallDto, @CurrentUser() user: RequestUser) {
    // Dispatch by source (issues #295, #296-300, #345): each system routes to its own
    // importer + enqueue path; per-source section/URL validation happens synchronously
    // inside enqueueInstall (400 before a job is created).
    return this.rules.enqueueInstall(body, user);
  }

  /**
   * Generic open-licensed dataset upload (issue #19): install a JSON rule pack for any
   * system (not just Open5e). Runs as the same kind of background job as Open5e install.
   * A non-open license is rejected synchronously with 400 before the job is enqueued.
   */
  @Post('packs/upload')
  @ServerRoles('admin')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Upload a generic open-licensed rule pack (background job)', description: 'Server admin only (packs are server-wide). The pack must carry an open license (OGL/ORC/CC/public domain). Returns 202 with an install job to poll.' })
  @ApiResponse({ status: 202, description: 'Install job accepted; poll packs/install-jobs/:id.' })
  @ApiResponse({ status: 400, description: 'Rejected — not an open license, or malformed payload.' })
  async upload(@Body() body: RulePackUploadDto, @CurrentUser() user: RequestUser) {
    return this.rules.enqueueUploadInstall(body, user);
  }

  @Get('packs/install-jobs/:id')
  @ApiOperation({ summary: 'Get install-job status', description: 'Any authenticated user. Poll for per-section progress and the final result of an install/upload.' })
  @ApiResponse({ status: 200, description: 'Install job status.' })
  @ApiResponse({ status: 404, description: 'No such job (or it was pruned after completion).' })
  getJob(@Param('id') id: string) {
    return this.rules.getJobOrThrow(id);
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
  @ApiOperation({
    summary: 'Search rule entries',
    description:
      'Any authenticated user. Searches across all installed packs unless `pack` is given. ' +
      'Returns a paginated page (`items`, `total`, `hasMore`, optional `nextCursor`) — default ' +
      'page size 50, max 100. Empty `q` browses with stable name+id order; continue with `cursor` ' +
      'from a previous `nextCursor` (issue #613).',
  })
  @ApiQuery({ name: 'q', required: false, description: 'Free-text search against entry name/summary. Empty returns all (subject to type/pack filters).' })
  @ApiQuery({ name: 'type', required: false, enum: ['spell', 'monster', 'item', 'class', 'race', 'condition', 'section', 'other'], description: 'Filter to one entry type.' })
  @ApiQuery({ name: 'pack', required: false, description: 'Filter to one pack by slug.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 50, max 100).' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque cursor from a previous page\'s nextCursor.' })
  @ApiResponse({ status: 200, description: 'Paginated matching rule entries (`items`, `total`, `hasMore`, `nextCursor?`).' })
  search(
    @Query('q') q: string | undefined,
    @Query('type') type: string | undefined,
    @Query('pack') pack: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ) {
    let parsedLimit: number | undefined;
    if (limit !== undefined && limit !== '') {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) {
        throw new BadRequestException('`limit` must be a positive integer');
      }
      parsedLimit = n;
    }
    return this.rules.search({
      q: q ?? '',
      type: type as RuleEntryType | undefined,
      pack,
      cursor,
      limit: parsedLimit,
    });
  }

  @Get('entries/:id')
  @ApiOperation({ summary: 'Get a rule entry', description: 'Any authenticated user.' })
  @ApiResponse({ status: 200, description: 'Rule entry.' })
  getEntry(@Param('id', ParseIntPipe) id: number) {
    return this.rules.getEntryOrThrow(id);
  }

  /**
   * Set the manual icon override on a rule entry (issue #305). Server-admin only, same gate
   * as install/uninstall (issue #736): compendium packs are server-wide, so editing an entry
   * affects every campaign using the pack. Reads stay open to everyone; only this edit is gated.
   */
  @Patch('entries/:id')
  @ServerRoles('admin')
  @ApiOperation({ summary: 'Update a rule entry', description: 'Server admin only. Sets the manual icon override.' })
  @ApiResponse({ status: 200, description: 'Updated rule entry.' })
  async updateEntry(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RuleEntryUpdateDto,
  ) {
    return this.rules.updateEntry(id, body);
  }
}
