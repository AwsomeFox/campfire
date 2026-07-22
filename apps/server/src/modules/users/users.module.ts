import { Module } from '@nestjs/common';
import { TokensModule } from '../tokens/tokens.module';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { UsersService } from './users.service';
import { MembershipIntegrityController, UsersController, UsersLookupController } from './users.controller';

@Module({
  imports: [TokensModule, AuditModule, RoleAccessModule],
  controllers: [MembershipIntegrityController, UsersLookupController, UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
