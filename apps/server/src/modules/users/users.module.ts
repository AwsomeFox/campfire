import { Module } from '@nestjs/common';
import { TokensModule } from '../tokens/tokens.module';
import { AuditModule } from '../audit/audit.module';
import { UsersService } from './users.service';
import { UsersController, UsersLookupController } from './users.controller';

@Module({
  imports: [TokensModule, AuditModule],
  controllers: [UsersLookupController, UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
