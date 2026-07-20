import { createZodDto } from 'nestjs-zod';
import { RulePackInstall, RulePackUpload } from '@campfire/schema';

export class RulePackInstallDto extends createZodDto(RulePackInstall) {}

/** Generic open-licensed dataset upload (issue #19). */
export class RulePackUploadDto extends createZodDto(RulePackUpload) {}
