import { Global, Module } from '@nestjs/common';
import { ServerMetaService } from './server-meta.service';

/**
 * Exposes {@link ServerMetaService} app-wide. Marked @Global so AuthService
 * (for /me) and BackupService (to bump the generation on restore) can inject it
 * without each adding this module to their imports — the data identity it owns
 * is cross-cutting infrastructure, exactly like DbModule. The service itself
 * only reads/writes the singleton `server_meta` row.
 */
@Global()
@Module({
  providers: [ServerMetaService],
  exports: [ServerMetaService],
})
export class ServerMetaModule {}
