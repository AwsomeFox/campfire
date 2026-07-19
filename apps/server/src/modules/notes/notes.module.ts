import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotesService } from './notes.service';
import { CampaignNotesController, NotesController } from './notes.controller';

@Module({
  imports: [AuditModule],
  controllers: [CampaignNotesController, NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
