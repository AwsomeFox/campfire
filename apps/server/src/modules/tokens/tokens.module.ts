import { Module } from '@nestjs/common';
import { RoleAccessModule } from '../membership/role-access.module';
import { TokensService } from './tokens.service';
import { TokensController } from './tokens.controller';

@Module({
  imports: [RoleAccessModule],
  controllers: [TokensController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
