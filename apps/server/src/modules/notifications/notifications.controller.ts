import { Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { NotificationsService } from './notifications.service';

/**
 * User-scoped (never campaign-scoped): every route operates on the CALLER's own
 * notifications only, so there is no campaign access check — the fan-out already
 * decided who may see what at write time.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications', description: 'Own notifications only, newest first.' })
  @ApiQuery({ name: 'unread', required: false, type: Boolean, description: 'If true, only unread notifications.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max rows (default 50, cap 200).' })
  @ApiResponse({ status: 200, description: 'Notifications for the caller.' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('unread') unread?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.listForUser(user, {
      unreadOnly: unread === 'true',
      limit: limit !== undefined ? Number(limit) : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count my unread notifications', description: 'Cheap poll target for the bell badge.' })
  @ApiResponse({ status: 200, description: '{ count }' })
  async unreadCount(@CurrentUser() user: RequestUser) {
    return { count: await this.notifications.unreadCount(user) };
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a notification read', description: 'Recipient only — 404 for anyone else. Idempotent.' })
  @ApiResponse({ status: 201, description: 'The notification, with readAt set.' })
  async markRead(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser) {
    return this.notifications.markRead(id, user);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all my notifications read' })
  @ApiResponse({ status: 201, description: '{ updated } — number of rows marked read.' })
  async markAllRead(@CurrentUser() user: RequestUser) {
    return this.notifications.markAllRead(user);
  }
}
