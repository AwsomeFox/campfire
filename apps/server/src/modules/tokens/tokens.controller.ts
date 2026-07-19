import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { RequestUser } from '../../common/user.types';
import { TokensService } from './tokens.service';
import { ApiTokenCreateDto } from './tokens.dto';

/** dev:* header users have no real users.id row and can't own tokens. */
function requireRealUserId(user: RequestUser): number {
  if (user.id.startsWith('dev:')) {
    throw new ForbiddenException('API tokens are not available for dev-auth users');
  }
  return Number(user.id);
}

@ApiTags('tokens')
@Controller('tokens')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.tokens.listOwn(requireRealUserId(user));
  }

  @Post()
  create(@Body() body: ApiTokenCreateDto, @CurrentUser() user: RequestUser) {
    return this.tokens.create(requireRealUserId(user), body, user);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: RequestUser): Promise<void> {
    await this.tokens.remove(requireRealUserId(user), id);
  }
}
