import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { QuestsModule } from '../quests/quests.module';
import { NpcsModule } from '../npcs/npcs.module';
import { LocationsModule } from '../locations/locations.module';
import { CharactersModule } from '../characters/characters.module';
import { SessionsModule } from '../sessions/sessions.module';
import { NotesModule } from '../notes/notes.module';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';

/**
 * Campaign-wide search + @-mention targets (issue #64). Composes the existing
 * per-entity services rather than querying tables directly, so all role
 * visibility / dmSecret redaction is inherited for free (see SearchService).
 */
@Module({
  imports: [RoleAccessModule, QuestsModule, NpcsModule, LocationsModule, CharactersModule, SessionsModule, NotesModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
