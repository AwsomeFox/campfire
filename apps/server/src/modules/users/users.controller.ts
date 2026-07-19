import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query, BadRequestException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ServerRoles } from '../../common/decorators/server-roles.decorator';
import { UsersService } from './users.service';
import { UserCreateDto, UserUpdateDto, PasswordChangeDto } from './users.dto';

/** Any authenticated user — used by the member-picker. Must be declared before UsersController so /users/lookup doesn't get swallowed by /users/:id-shaped routes in admin controller ordering. */
@ApiTags('users')
@Controller('users')
export class UsersLookupController {
  constructor(private readonly users: UsersService) {}

  @Get('lookup')
  lookup(@Query('query') query: string | undefined) {
    if (!query || query.trim().length < 2) {
      throw new BadRequestException('query must be at least 2 characters');
    }
    return this.users.lookup(query.trim());
  }
}

@ApiTags('users')
@Controller('users')
@ServerRoles('admin')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  create(@Body() body: UserCreateDto) {
    return this.users.create(body);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: UserUpdateDto) {
    return this.users.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.users.remove(id);
  }

  @Post(':id/password')
  @HttpCode(204)
  async setPassword(@Param('id', ParseIntPipe) id: number, @Body() body: PasswordChangeDto) {
    await this.users.setPassword(id, body.newPassword);
  }
}
