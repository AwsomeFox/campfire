import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { NotesModule } from '../notes/notes.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { InboxSweepService } from './inbox-sweep.service';
import { InboxSweepController } from './inbox-sweep.controller';
import { AiInboxSweepClassifier, INBOX_SWEEP_CLASSIFIER } from './inbox-sweep-classifier';

/**
 * Inbox sweep (issue #1644) — isolated module, the foundation slice of #1306.
 *
 * Reuses the campaign-summary bootstrap (CampaignsModule), the inbox read/resolve path
 * (NotesModule), and the proposal write path (ProposalRecordsModule) — never binds an
 * LLM vendor itself, only the encrypted provider config (AiProviderConfigModule) that
 * feeds `createAiProvider`, same as the AI scribe (#316).
 */
@Module({
  imports: [RoleAccessModule, NotesModule, ProposalRecordsModule, CampaignsModule, AiProviderConfigModule],
  controllers: [InboxSweepController],
  providers: [InboxSweepService, { provide: INBOX_SWEEP_CLASSIFIER, useClass: AiInboxSweepClassifier }],
  exports: [InboxSweepService],
})
export class InboxSweepModule {}
