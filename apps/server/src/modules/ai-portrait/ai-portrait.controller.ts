import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WriteModeExempt } from '../../common/decorators/proposable.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { AiPortraitService } from './ai-portrait.service';
import {
  AiPortraitGenerationDto,
  AiPortraitRefineDto,
  AttachGeneratedPortraitDto,
} from './ai-portrait.dto';

/**
 * AI portrait generation REST surface (issue #1321). Generation jobs expose status/progress/cancel
 * and honor an `Idempotency-Key` header. Previews live only in memory — nothing is persisted until
 * the caller explicitly attaches a chosen candidate, so a cancel or a provider failure never leaves
 * an orphan file. Generation is member-scoped; linking a portrait onto an entity reuses the domain
 * service's own dm-or-owner (character) / dm-only (NPC) authority.
 */
@ApiTags('portraits')
@Controller('campaigns/:campaignId/ai-portraits')
export class AiPortraitController {
  constructor(
    private readonly aiPortrait: AiPortraitService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Cost + readiness for a brief WITHOUT spending (issue #1321). Non-mutating (no provider call,
   * no persistence), so it's WriteModeExempt — a read-only token may still preview cost/readiness.
   * Member-scoped (players may preview cost for their own PCs).
   */
  @Post('readiness')
  @WriteModeExempt()
  @ApiOperation({ summary: 'Estimate cost + readiness for an AI portrait brief without generating' })
  @ApiResponse({ status: 201, description: 'Method, capabilities, cost, moderation, and readiness warnings.' })
  async readiness(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: AiPortraitGenerationDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'player');
    return this.aiPortrait.readiness(campaignId, body);
  }

  /**
   * Create a generation job and return the completed job with in-memory previews (issue #1321).
   * Member-scoped write (spends a provider call). Pass `Idempotency-Key` to make a retried create
   * return the same job.
   */
  @Post()
  @ApiOperation({ summary: 'Generate AI portrait candidates (image provider → external instructions)' })
  @ApiResponse({ status: 201, description: 'The completed job with previews (or external instructions).' })
  @ApiResponse({ status: 503, description: 'Rate-limited or too many concurrent generations.' })
  async generate(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: AiPortraitGenerationDto,
    @CurrentUser() user: RequestUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.aiPortrait.createJob(campaignId, body, user, role, { idempotencyKey, caller: 'dm' });
  }

  /** Fetch a job's status/progress/previews (issue #1321). Read; WriteModeExempt. */
  @Get(':jobId')
  @WriteModeExempt()
  @ApiOperation({ summary: 'Get an AI portrait generation job status' })
  @ApiResponse({ status: 200, description: 'The job status view.' })
  async status(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'player');
    return this.aiPortrait.getJob(jobId, campaignId);
  }

  /** Cancel a job (issue #1321). Aborts any in-flight render; leaves no orphan files. */
  @Post(':jobId/cancel')
  @ApiOperation({ summary: 'Cancel an AI portrait generation job' })
  @ApiResponse({ status: 201, description: 'The cancelled job.' })
  async cancel(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.aiPortrait.cancelJob(jobId, campaignId, user, role);
  }

  /** Refine a job: tweak prompt/count and regenerate (issue #1321). */
  @Post(':jobId/refine')
  @ApiOperation({ summary: 'Refine an AI portrait generation job' })
  @ApiResponse({ status: 201, description: 'The new refined job.' })
  async refine(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @Body() body: AiPortraitRefineDto,
    @CurrentUser() user: RequestUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.aiPortrait.refine(campaignId, jobId, body, user, role, { idempotencyKey });
  }

  /**
   * Attach a chosen candidate as a `kind='portrait'` attachment (issue #1321) and set it as the
   * target entity's `portraitUrl`. Member-scoped write — but the internal entity-link enforces
   * dm-or-owner for a character and dm-only for an NPC, exactly like a manual portrait upload.
   */
  @Post(':jobId/attach')
  @ApiOperation({ summary: 'Attach a generated AI portrait candidate to a character or NPC' })
  @ApiResponse({ status: 201, description: 'The stored attachment + linked entity + provenance.' })
  @ApiResponse({ status: 413, description: 'Attaching would exceed the campaign storage quota.' })
  async attach(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @Body() body: AttachGeneratedPortraitDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.aiPortrait.attach(campaignId, jobId, body, user, role);
  }
}
