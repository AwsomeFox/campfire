import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { QuestsModule } from '../quests/quests.module';
import { SessionsModule } from '../sessions/sessions.module';
import { TimelineModule } from '../timeline/timeline.module';
import { CatchUpService } from './catch-up.service';
import { CatchUpController } from './catch-up.controller';

@Module({
  imports: [MembershipModule, QuestsModule, SessionsModule, TimelineModule],
  controllers: [CatchUpController],
  providers: [CatchUpService],
  exports: [CatchUpService],
})
export class CatchUpModule {}
