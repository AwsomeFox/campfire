import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { RevisionsService } from './revisions.service';
import { RevisionsController } from './revisions.controller';

/**
 * Prose revision history + optimistic-concurrency guard (issue #157). RevisionsService
 * is exported so the prose entity modules (sessions/quests/npcs/locations) can inject it
 * to snapshot prior content on update and clean up on delete. Importing modules only need
 * to add RevisionsModule to their `imports` — no dependency flows the other way, so there
 * is no cycle.
 */
@Module({
  imports: [AuditModule, RoleAccessModule],
  controllers: [RevisionsController],
  providers: [RevisionsService],
  exports: [RevisionsService],
})
export class RevisionsModule {}
