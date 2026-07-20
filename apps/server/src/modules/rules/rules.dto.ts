import { createZodDto } from 'nestjs-zod';
import { RulePackInstall, RulePackUpload } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131). Only the top-level keys are guarded;
// nested pack/entries keep their own schemas.
export class RulePackInstallDto extends createZodDto(RulePackInstall.strict()) {}

/** Generic open-licensed dataset upload (issue #19). */
export class RulePackUploadDto extends createZodDto(RulePackUpload.strict()) {}
