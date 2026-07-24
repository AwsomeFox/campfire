import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EventsModule } from '../events/events.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
// RevisionsService hosts the shared optimistic-concurrency guard (assertNotStale) used by
// the character update path (issue #746); adding its module here makes it injectable. See
// encounters.module.ts / npcs.module.ts for the same import.
import { RevisionsModule } from '../revisions/revisions.module';
// Issue #415: catalog check rolls persist to the shared dice log via RollsService.
import { RollsModule } from '../rolls/rolls.module';
import { CharactersService } from './characters.service';
import {
  CampaignCharactersController,
  CharactersController,
  CampaignCheckRequestsController,
  CheckRequestsController,
} from './characters.controller';

@Module({
  imports: [AuditModule, EventsModule, RoleAccessModule, ProposalRecordsModule, RevisionsModule, RollsModule],
  controllers: [
    CampaignCharactersController,
    CharactersController,
    CampaignCheckRequestsController,
    CheckRequestsController,
  ],
  providers: [CharactersService],
  exports: [CharactersService],
})
export class CharactersModule {}
