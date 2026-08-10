import { Body, Controller, Delete, Get, Inject, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { NotificationsService } from './notifications.service';
import {
  BrowserPushSubscriptionDto,
  BrowserPushUnsubscribeDto,
  BulkNotificationDto,
  NotificationPreferencesUpdateDto,
} from './notifications.dto';
import { PushNotificationsService } from './push-notifications.service';

/**
 * User-scoped (never campaign-scoped): every route operates on the CALLER's own
 * notifications only, so there is no campaign access check — the fan-out already
 * decided who may see what at write time.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(PushNotificationsService)
    private readonly push: Pick<PushNotificationsService, 'status' | 'subscribe' | 'unsubscribe'>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications', description: 'Own notifications only, newest first, with cursor pagination and filters.' })
  @ApiQuery({ name: 'unread', required: false, type: Boolean, description: 'If true, only unread notifications.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max rows (default 50, cap 200).' })
  @ApiQuery({ name: 'cursor', required: false, type: Number, description: 'Cursor notification ID for pagination.' })
  @ApiQuery({ name: 'campaignId', required: false, type: Number, description: 'Filter by campaign ID.' })
  @ApiQuery({ name: 'type', required: false, type: String, description: 'Filter by notification type.' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'Filter created on or after date.' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'Filter created on or before date.' })
  @ApiResponse({ status: 200, description: 'Paginated notifications for the caller.' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('campaignId') campaignId?: string,
    @Query('type') type?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.notifications.listForUser(user, {
      unreadOnly: unread === 'true',
      limit: limit && !isNaN(Number(limit)) ? Number(limit) : undefined,
      cursor: cursor && !isNaN(Number(cursor)) ? Number(cursor) : undefined,
      campaignId: campaignId && !isNaN(Number(campaignId)) ? Number(campaignId) : undefined,
      type: type || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Count my unread notifications',
    description:
      'Cheap poll target for the bell badge. Also reports `membershipChanged` (issue #1590): true ' +
      "when an unread notification means the caller's own membership/role changed somewhere, so " +
      "the account-wide poller that already runs regardless of which campaign (or none) is open " +
      'can tell that from ordinary table activity and refresh `/me`. Both fields read only the ' +
      "caller's own notifications, same as always.",
  })
  @ApiResponse({ status: 200, description: '{ count, membershipChanged }' })
  async unreadCount(@CurrentUser() user: RequestUser) {
    return this.notifications.unreadSummary(user);
  }

  @Get('preferences')
  @ApiOperation({
    summary: 'Get my notification preferences',
    description:
      'Per-campaign, per-category delivery modes + quiet hours for every campaign the caller belongs to. Defaults are filled in for unset categories/campaigns (issue #789).',
  })
  @ApiResponse({ status: 200, description: '{ campaigns: NotificationCampaignPreferences[] }' })
  async getPreferences(@CurrentUser() user: RequestUser) {
    return this.notifications.getPreferences(user);
  }

  @Put('preferences/:campaignId')
  @ApiOperation({
    summary: 'Update my notification preferences for a campaign',
    description:
      'Additive/partial upsert of category delivery modes and/or the quiet-hours window. Critical (access/security) categories stay always-on. 404 when the caller is not a member.',
  })
  @ApiResponse({ status: 200, description: 'The resolved NotificationCampaignPreferences for the campaign.' })
  async updatePreferences(
    @Param('campaignId', ParseIntPipe) campaignId: number,
    @Body() body: NotificationPreferencesUpdateDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.notifications.setPreferences(user, campaignId, body);
  }

  @Get('push-status')
  @ApiOperation({
    summary: 'Get browser push configuration',
    description: 'Returns whether Web Push is configured and, when enabled, the public VAPID key. No private key or subscription is exposed.',
  })
  @ApiResponse({ status: 200, description: '{ configured, publicKey }' })
  pushStatus() {
    return this.push.status();
  }

  @Post('push-subscribe')
  @ApiOperation({ summary: 'Subscribe this browser to my notifications' })
  @ApiResponse({ status: 201, description: 'The public browser-push configuration.' })
  async subscribePush(
    @CurrentUser() user: RequestUser,
    @Body() body: BrowserPushSubscriptionDto,
  ) {
    return this.push.subscribe(user, body);
  }

  @Delete('push-subscribe')
  @ApiOperation({ summary: 'Unsubscribe this browser from my notifications' })
  @ApiResponse({ status: 200, description: '{ removed }' })
  async unsubscribePush(
    @CurrentUser() user: RequestUser,
    @Body() body: BrowserPushUnsubscribeDto,
  ) {
    return this.push.unsubscribe(user, body.endpoint);
  }

  @Post('mark-read')
  @ApiOperation({ summary: 'Mark selected, campaign, or all notifications read' })
  @ApiResponse({ status: 201, description: '{ updated, updatedIds }' })
  async markReadBulk(@CurrentUser() user: RequestUser, @Body() body: BulkNotificationDto) {
    return this.notifications.markReadBulk(user, body);
  }

  @Post('mark-unread')
  @ApiOperation({ summary: 'Mark selected, campaign, or all notifications unread' })
  @ApiResponse({ status: 201, description: '{ updated, updatedIds }' })
  async markUnreadBulk(@CurrentUser() user: RequestUser, @Body() body: BulkNotificationDto) {
    return this.notifications.markUnreadBulk(user, body);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a notification read', description: 'Recipient only — 404 for anyone else. Idempotent.' })
  @ApiResponse({ status: 201, description: 'The notification, with readAt set.' })
  async markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.notifications.markRead(id, user);
  }

  @Post(':id/unread')
  @ApiOperation({ summary: 'Mark a notification unread', description: 'Recipient only — 404 for anyone else. Idempotent.' })
  @ApiResponse({ status: 201, description: 'The notification, with readAt set to null.' })
  async markUnread(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.notifications.markUnread(id, user);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all my notifications read' })
  @ApiResponse({ status: 201, description: '{ updated, updatedIds } — number of rows marked read.' })
  async markAllRead(@CurrentUser() user: RequestUser) {
    return this.notifications.markAllRead(user);
  }
}
