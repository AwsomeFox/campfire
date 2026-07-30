import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { CampaignAccessService } from '../membership/campaign-access.service';
import { InventoryService } from './inventory.service';
import { InventoryFromCompendiumDto, InventoryItemCreateDto, InventoryItemUpdateDto, TreasuryPatchDto } from './inventory.dto';

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
    const role = await this.access.requireMember(user, campaignId);
    return this.inventory.listForCampaign(campaignId, user, role);
  }

  @Get('trash')
  @ApiOperation({ summary: 'List trashed inventory items', description: 'Soft-deleted items in this campaign, newest first. Player+ required.' })
  @ApiResponse({ status: 200, description: 'Trashed inventory items.' })
  async listTrash(@Param('campaignId', ParseIntPipe) campaignId: number, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.inventory.listTrashForCampaign(campaignId, user, role);
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

  @Post('from-compendium')
  @ApiOperation({ summary: 'Acquire an installed compendium item', description: 'player role required. Captures a play-safe provenance snapshot; duplicate confirmation is required unless duplicateMode is increment or separate.' })
  async fromCompendium(@Param('campaignId', ParseIntPipe) campaignId: number, @Body() body: InventoryFromCompendiumDto, @CurrentUser() user: RequestUser) {
    const role = await this.access.requireRole(user, campaignId, 'player');
    return this.inventory.acquireFromCompendium(campaignId, body, user, role);
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
    const role = await this.access.requireMember(user, row.campaignId);
    return this.inventory.getOrThrow(id, user, role);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an inventory item',
    description:
      'player role required; character items only by dm or the owning player. May also move the item (ownerType/characterId) — moving requires write access at both the source and the destination. ' +
      'Quantity (issue #782): prefer `{ qtyDelta, idempotencyKey }` for atomic +/- (retries with the same key replay the committed item); ' +
      'an absolute `{ qty }` reconciliation requires `expectedUpdatedAt` (CAS) and returns 409 with the live item on conflict. ' +
      'Equip/unequip (issue #1326): `{ equipped: true, equipSlot }` — only a character-owned item may be equipped, equipSlot is ' +
      'required, and a second item equipped into the same (character, slot) returns 409 INVENTORY_SLOT_CONFLICT; ' +
      '`{ equipped: false }` clears the slot. `equippedAction` attaches a structured action the item grants while equipped ' +
      '(surfaced by GET .../actions on the item\'s character combatant).',
  })
  @ApiResponse({ status: 200, description: 'Updated item.' })
  @ApiResponse({ status: 400, description: 'qty without expectedUpdatedAt, qtyDelta without idempotencyKey, both qty shapes, a delta that would go negative, equipping a party-stash item, or equipping without equipSlot.' })
  @ApiResponse({ status: 403, description: 'Not the dm or the owning player of the item\'s character.' })
  @ApiResponse({ status: 409, description: 'Absolute qty CAS mismatch (INVENTORY_QTY_CONFLICT), idempotency key reused with a different payload, or equipSlot already occupied (INVENTORY_SLOT_CONFLICT).' })
  async update(@Param('id', ParseIntPipe) id: number, @Body() body: InventoryItemUpdateDto, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.update(id, body, user, role);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an inventory item', description: 'Soft-deletes the item to campaign trash. player role required; character items only by dm or the owning player.' })
  @ApiResponse({ status: 200, description: 'Soft-deleted item.' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id);
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.remove(id, user, role);
  }

  @Post(':id/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restore a soft-deleted inventory item', description: 'Restores the item from trash to its original owner (party stash if the character is gone). player role required; restricted to dm, the deleting player, or the owning player. Any player may restore party-stash items.' })
  @ApiResponse({ status: 200, description: 'Restored item.' })
  async restore(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id, { includeDeleted: true });
    const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.restore(id, user, role);
  }

  @Post(':id/compendium/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refresh a linked inventory item from its installed compendium source', description: 'player role required. Updates the stored snapshot and clears linked_updated; local qty/notes are preserved.' })
  async refresh(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    const row = await this.inventory.getRowOrThrow(id); const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.refreshCompendium(id, user, role);
  }

  @Post(':id/compendium/:state')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark a linked inventory item overridden or detached', description: 'player role required. overridden keeps the local link; detached clears ruleEntryId while retaining the play-safe snapshot.' })
  async compendiumState(@Param('id', ParseIntPipe) id: number, @Param('state') state: 'overridden' | 'detached', @CurrentUser() user: RequestUser) {
    if (state !== 'overridden' && state !== 'detached') throw new BadRequestException('Unsupported compendium state');
    const row = await this.inventory.getRowOrThrow(id); const role = await this.access.requireRole(user, row.campaignId, 'player');
    return this.inventory.setCompendiumState(id, state, user, role);
  }
}
