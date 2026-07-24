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
import { AiMapService } from './ai-map.service';
import { AiMapGenerationDto, AiMapRefineDto, AttachGeneratedMapDto } from './ai-map.dto';

/**
 * Genuine AI map generation REST surface (issue #410). dm-only throughout. Generation jobs
 * expose status/progress/cancel and honor an `Idempotency-Key` header. Previews live only in
 * memory — nothing is persisted until the DM explicitly attaches a chosen candidate, so a
 * cancel or a provider failure never leaves an orphan file.
 */
@ApiTags('maps')
@Controller('campaigns/:campaignId/ai-maps')
export class AiMapController {
  constructor(
    private readonly aiMap: AiMapService,
    private readonly access: CampaignAccessService,
  ) {}

  /**
   * Cost + readiness for a brief WITHOUT spending (issue #410). Non-mutating (no provider
   * call, no persistence), so it's WriteModeExempt — a read-only token may still preview
   * cost/readiness. Returns the method that would be used, provider capabilities, cost
   * estimate, moderation result, and grid/doors/corridors warnings.
   */
  @Post('readiness')
  @WriteModeExempt()
  @ApiOperation({ summary: 'Estimate cost + readiness for an AI map brief without generating' })
  @ApiResponse({ status: 201, description: 'Method, capabilities, cost, moderation, and readiness warnings.' })
  async readiness(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: AiMapGenerationDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.aiMap.readiness(campaignId, body);
  }

  /**
   * Create a generation job and return the completed job with in-memory previews (issue #410).
   * dm-only; a write (spends a provider call) so the global WriteModeGuard rejects a read-only
   * token. Pass `Idempotency-Key` to make a retried create return the same job.
   */
  @Post()
  @ApiOperation({ summary: 'Generate AI map candidates (image provider → procedural blueprint → external instructions)' })
  @ApiResponse({ status: 201, description: 'The completed job with previews (or external instructions).' })
  @ApiResponse({ status: 503, description: 'Rate-limited or too many concurrent generations.' })
  async generate(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: AiMapGenerationDto,
    @CurrentUser() user: RequestUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.aiMap.createJob(campaignId, body, user, role, { idempotencyKey, caller: 'dm' });
  }

  /** Fetch a job's status/progress/previews (issue #410). Read; WriteModeExempt. */
  @Get(':jobId')
  @WriteModeExempt()
  @ApiOperation({ summary: 'Get an AI map generation job status' })
  @ApiResponse({ status: 200, description: 'The job status view.' })
  async status(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.access.requireRole(user, campaignId, 'dm');
    return this.aiMap.getJob(jobId, campaignId);
  }

  /** Cancel a job (issue #410). Aborts any in-flight render; leaves no orphan files. */
  @Post(':jobId/cancel')
  @ApiOperation({ summary: 'Cancel an AI map generation job' })
  @ApiResponse({ status: 201, description: 'The cancelled job.' })
  async cancel(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.aiMap.cancelJob(jobId, campaignId, user, role);
  }

  /** Refine a job: tweak prompt/chips and regenerate (issue #410). */
  @Post(':jobId/refine')
  @ApiOperation({ summary: 'Refine an AI map generation job' })
  @ApiResponse({ status: 201, description: 'The new refined job.' })
  async refine(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @Body() body: AiMapRefineDto,
    @CurrentUser() user: RequestUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    return this.aiMap.refine(campaignId, jobId, body, user, role, { idempotencyKey });
  }

  /**
   * Attach a chosen candidate as a hidden 'map' attachment (issue #410) and optionally link it
   * to an encounter. dm-only write. This is the only path that touches disk/the attachment
   * store; the DM performing it is authorized to reveal/replace a live map.
   */
  @Post(':jobId/attach')
  @ApiOperation({ summary: 'Attach a generated AI map candidate (hidden by default)' })
  @ApiResponse({ status: 201, description: 'The stored attachment + optional encounter linkage + provenance.' })
  @ApiResponse({ status: 413, description: 'Attaching would exceed the campaign storage quota.' })
  async attach(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Param('jobId') jobId: string,
    @Body() body: AttachGeneratedMapDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'dm');
    // A DM attaching via REST is explicitly authorized to reveal/replace a live map.
    return this.aiMap.attach(campaignId, jobId, body, user, role, { allowLiveReplace: true });
  }
}
