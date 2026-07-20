import { createZodDto } from 'nestjs-zod';
import { RulePackInstall } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class RulePackInstallDto extends createZodDto(RulePackInstall.strict()) {}
