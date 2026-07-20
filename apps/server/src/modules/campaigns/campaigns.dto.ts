import { createZodDto } from 'nestjs-zod';
import { CampaignClone, CampaignCreate, CampaignImport, CampaignUpdate } from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment.
export class CampaignCreateDto extends createZodDto(CampaignCreate.strict()) {}
export class CampaignUpdateDto extends createZodDto(CampaignUpdate.strict()) {}
export class CampaignCloneDto extends createZodDto(CampaignClone.strict()) {}
// NOT .strict(): an import body is a whole export document with many top-level and
// nested keys the importer intentionally ignores (attachmentsNote, members, audit,
// proposals, attachment metadata, …). CampaignImport keeps .passthrough() so those
// extra keys are tolerated rather than rejected — see @campfire/schema.
export class CampaignImportDto extends createZodDto(CampaignImport) {}
