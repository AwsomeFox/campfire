import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController, UsersLookupController } from './users.controller';

@Module({
  controllers: [UsersLookupController, UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
