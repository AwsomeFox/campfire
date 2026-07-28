import { createZodDto } from 'nestjs-zod';
import { RulePackInstall, RulePackUpload, RuleEntryUpdate, HomebrewRuleEntryInput, HomebrewRuleEntryUpdate, HomebrewImportPreview, HomebrewImportApply } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131). Only the top-level keys are guarded;
// nested pack/entries keep their own schemas.
export class RulePackInstallDto extends createZodDto(RulePackInstall.strict()) {}

/** Generic open-licensed dataset upload (issue #19). */
export class RulePackUploadDto extends createZodDto(RulePackUpload.strict()) {}

/** DM/admin edit to an imported rule entry — the manual icon override (issue #305). */
export class RuleEntryUpdateDto extends createZodDto(RuleEntryUpdate.strict()) {}
export class HomebrewRuleEntryDto extends createZodDto(HomebrewRuleEntryInput) {}
export class HomebrewRuleEntryUpdateDto extends createZodDto(HomebrewRuleEntryUpdate.strict()) {}
export class HomebrewImportPreviewDto extends createZodDto(HomebrewImportPreview.strict()) {}
export class HomebrewImportApplyDto extends createZodDto(HomebrewImportApply.strict()) {}
