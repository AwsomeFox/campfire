import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { RoleAccessModule } from '../membership/role-access.module';
import { NotesModule } from '../notes/notes.module';
import { EncountersModule } from '../encounters/encounters.module';
import { ProposalRecordsModule } from '../proposals/proposal-records.module';
import { AiProviderConfigModule } from '../ai-provider-config/ai-provider-config.module';
import { AiDmModule } from '../ai-dm/ai-dm.module';
import { ScribeService } from './scribe.service';
import { ScribeController } from './scribe.controller';

/**
 * Automatic / scheduled AI scribe (issue #316) — isolated module.
 *
 * Drafts session recaps from a campaign's own material (reusing draft_session_recap's
 * assembly) and files them as PROPOSALS. Reuses the AI-DM seat governance (via
 * AiDmModule's exported provider seam + SettingsModule's experimental flag), the
 * encrypted provider config (#310, AiProviderConfigModule), and the proposal write
 * path (ProposalRecordsModule). Never binds an LLM vendor itself.
 */
@Module({
  imports: [
    AuditModule,
    SettingsModule,
    RoleAccessModule,
    NotesModule,
    EncountersModule,
    ProposalRecordsModule,
    AiProviderConfigModule,
    AiDmModule,
  ],
  controllers: [ScribeController],
  providers: [ScribeService],
  exports: [ScribeService],
})
export class ScribeModule {}
