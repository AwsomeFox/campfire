import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { parsePageParams } from '../../common/pagination';
import { AuditService } from './audit.service';
import { clampAuditListLimit } from './audit-pagination';

/**
 * Audit list paging (issue #71). Default page size stays 100 (unchanged for
 * existing callers); `?limit`/`?offset` now let a client page BACK through older
 * history that the hardcoded cap-100 previously made unreachable via the API.
 *
 * Issue #443: pass `envelope=1` (or any filter/cursor param) for the cursor-paginated
 * `{ items, total, hasMore, nextCursor, limit }` shape used by the campaign audit UI.
 */
export const AUDIT_DEFAULT_LIMIT = 100;
export const AUDIT_MAX_LIMIT = 500;

function parseOptionalInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new BadRequestException(`\`${name}\` must be an integer`);
  return n;
}

function wantsEnvelope(query: Record<string, string | undefined>): boolean {
  return query.envelope === '1' || query.envelope === 'true' || query.cursor !== undefined;
}

@ApiTags('audit')
@Controller('campaigns/:id/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List recent audit entries for a campaign',
    description:
      'dm role required. Most-recent-first. Defaults to 100 entries; page with `?limit` (max 500) and `?offset`. ' +
      'Pass `envelope=1` (or any filter/cursor param) for cursor pagination (`items`, `total`, `hasMore`, `nextCursor`).',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max entries to return (default 100 legacy / 50 envelope, max 500 / 200 envelope).' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Entries to skip, for legacy offset paging (default 0).' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: "Opaque cursor from a previous page's nextCursor (issue #443)." })
  @ApiQuery({ name: 'envelope', required: false, type: String, description: 'Set to 1 for the paginated envelope shape (issue #443).' })
  @ApiQuery({ name: 'action', required: false, type: String, description: 'Filter to a single action, e.g. "npc.update".' })
  @ApiQuery({ name: 'entityType', required: false, type: String, description: 'Filter to a single entity type, e.g. "quest".' })
  @ApiQuery({ name: 'entityId', required: false, type: Number, description: 'Filter to a single entity id (requires entityType for meaningful results).' })
  @ApiQuery({ name: 'actor', required: false, type: String, description: 'Filter to a single actor (user id or token:<name>).' })
  @ApiQuery({ name: 'sinceTs', required: false, type: String, description: 'Only entries created strictly after this ISO-8601 timestamp.' })
  @ApiQuery({ name: 'untilTs', required: false, type: String, description: 'Only entries created at or before this ISO-8601 timestamp.' })
  @ApiQuery({ name: 'requestId', required: false, type: String, description: 'Filter to rows stamped with this correlation id (issue #684).' })
  @ApiResponse({ status: 200, description: 'Audit entries (bare array or paginated envelope).' })
  async list(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('cursor') cursor?: string,
    @Query('envelope') envelope?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actor') actor?: string,
    @Query('sinceTs') sinceTs?: string,
    @Query('untilTs') untilTs?: string,
    @Query('requestId') requestId?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    // allowArchived: reading the audit log of an archived (read-only) campaign is fine.
    await this.access.requireRole(user, id, 'dm', { allowArchived: true });
    if (res) await this.audit.setRetentionHeaders(res);

    const filters = {
      action,
      entityType,
      entityId: parseOptionalInt(entityId, 'entityId'),
      actor,
      sinceTs,
      untilTs,
      requestId,
    };

    if (wantsEnvelope({ envelope, cursor })) {
      const pageLimit = limit != null && limit !== '' ? clampAuditListLimit(Number(limit)) : undefined;
      return this.audit.listForCampaignPage(id, {
        limit: pageLimit,
        cursor,
        ...filters,
      });
    }

    const page = parsePageParams({ limit, offset }, AUDIT_MAX_LIMIT);
    return this.audit.listForCampaign(id, page.limit ?? AUDIT_DEFAULT_LIMIT, page.offset ?? 0, filters);
  }
}
