import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { InventoryService } from './inventory.service';
import { InventoryItemCreateDto, InventoryItemUpdateDto, TreasuryPatchDto } from './inventory.dto';

@ApiTags('inventory')
@Controller('campaigns/:campaignId/inventory')
export class CampaignInventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List inventory items in a campaign', description: 'Requires campaign membership. Party stash and per-character items together; group client-side by ownerType/characterId.' })
  @ApiResponse({ status: 200, description: 'Inventory items.' })
  async list(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.inventory.listForCampaign(campaignId);
  }

  @Post()
  @ApiOperation({ summary: 'Add an inventory item', description: 'player role required. Party items are writable by any player; character items only by the dm or the character\'s owning player.' })
  @ApiResponse({ status: 201, description: 'Created item.' })
  @ApiResponse({ status: 400, description: 'Inconsistent owner (characterId missing/extra, or not in this campaign).' })
  async create(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: InventoryItemCreateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.inventory.create(campaignId, body, user, role);
  }
}

@ApiTags('inventory')
@Controller('campaigns/:campaignId/treasury')
export class CampaignTreasuryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get the party treasury', description: 'Requires campaign membership. Coin totals (cp/sp/ep/gp/pp); a zeroed row is created lazily.' })
  @ApiResponse({ status: 200, description: 'Treasury coin totals.' })
  async get(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    await this.access.requireMember(user, campaignId);
    return this.inventory.getTreasury(campaignId);
  }

  @Patch()
  @ApiOperation({ summary: 'Adjust the party treasury', description: 'player role required. Body is a union: { delta: {gp, …} } (relative, result must stay >= 0) or { set: {gp, …} } (absolute).' })
  @ApiResponse({ status: 200, description: 'Updated treasury.' })
  @ApiResponse({ status: 400, description: 'A delta would make a denomination negative.' })
  async patch(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: TreasuryPatchDto,
    @CurrentUser() user: RequestUser,
  ) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.inventory.patchTreasury(campaignId, body, user, role);
  }
}

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly access: CampaignAccessService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get an inventory item', description: 'Requires campaign membership.' })
  @ApiResponse({ status: 200, description: 'Inventory item.' })
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id);
    await this.access.requireMember(user, row.campaignId);
    return this.inventory.getOrThrow(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an inventory item',
    description:
      'player role required; character items only by dm or the owning player. May also move the item (ownerType/characterId) — moving requires write access at both the source and the destination. ' +
      'Quantity (issue #782): prefer `{ qtyDelta, idempotencyKey }` for atomic +/- (retries with the same key replay the committed item); ' +
      'an absolute `{ qty }` reconciliation requires `expectedUpdatedAt` (CAS) and returns 409 with the live item on conflict.',
  })
  @ApiResponse({ status: 200, description: 'Updated item.' })
  @ApiResponse({ status: 400, description: 'qty without expectedUpdatedAt, qtyDelta without idempotencyKey, both qty shapes, or a delta that would go negative.' })
  @ApiResponse({ status: 403, description: 'Not the dm or the owning player of the item\'s character.' })
  @ApiResponse({ status: 409, description: 'Absolute qty CAS mismatch (INVENTORY_QTY_CONFLICT) or idempotency key reused with a different payload.' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: InventoryItemUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an inventory item', description: 'player role required; character items only by dm or the owning player.' })
  @ApiResponse({ status: 200, description: 'Deleted.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.remove(id, user, role);
  }
}
