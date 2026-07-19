import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from './role-access.module';
import { MembersService } from './members.service';
import { MembersController } from './members.controller';

@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [MembersController],
  providers: [MembersService],
  exports: [RoleAccessModule, MembersService],
})
export class MembershipModule {}
