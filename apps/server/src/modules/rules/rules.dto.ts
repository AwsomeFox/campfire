import { createZodDto } from 'nestjs-zod';
import { RulePackInstall } from '@campfire/schema';

export class RulePackInstallDto extends createZodDto(RulePackInstall) {}
