import { Module } from '@nestjs/common';
import { TokensModule } from '../tokens/tokens.module';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { UsersService } from './users.service';
import { RosterImportService } from './roster-import.service';
import { MembershipIntegrityController, UsersController, UsersLookupController } from './users.controller';
import { RosterImportController } from './roster-import.controller';

@Module({
  imports: [TokensModule, AuditModule, RoleAccessModule],
  controllers: [MembershipIntegrityController, UsersLookupController, UsersController, RosterImportController],
  providers: [UsersService, RosterImportService],
  exports: [UsersService],
})
export class UsersModule {}
