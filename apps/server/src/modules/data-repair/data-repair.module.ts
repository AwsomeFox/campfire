import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DataRepairController } from './data-repair.controller';
import { DataRepairService } from './data-repair.service';
@Module({ imports: [AuditModule], controllers: [DataRepairController], providers: [DataRepairService], exports: [DataRepairService] })
export class DataRepairModule {}
