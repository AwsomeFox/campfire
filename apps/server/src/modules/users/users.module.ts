import { Module } from '@nestjs/common';
import { TokensModule } from '../tokens/tokens.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { UsersService } from './users.service';
import { UsersController, UsersLookupController } from './users.controller';

@Module({
  imports: [TokensModule, RoleAccessModule],
  controllers: [UsersLookupController, UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
