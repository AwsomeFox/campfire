import { createZodDto } from 'nestjs-zod';
import {
  CampaignCatalogBulkRequest,
  CampaignCatalogBulkResult,
  CampaignCatalogEntry,
  CampaignCatalogPage,
  CampaignCatalogPrivacyPolicy,
  CampaignCatalogPrivacyPolicyUpdate,
  CampaignCatalogPrivacySetting,
  CampaignCatalogPrivacyUpdate,
  CampaignExportRequest,
  CampaignExportRequestPage,
  CampaignExportRequestDecision,
} from '@campfire/schema';

// `.strict()` on every request body, matching notes/comments/moderation: an
// unrecognized key 400s rather than being silently dropped. That matters more than
// usual for bulk lifecycle ops — an operator who typoed `dryRun` as `dryrun` must be
// told, not quietly given a real run across 200 campaigns.
export class CampaignCatalogBulkRequestDto extends createZodDto(CampaignCatalogBulkRequest) {}
export class CampaignCatalogPrivacyPolicyUpdateDto extends createZodDto(
  CampaignCatalogPrivacyPolicyUpdate.strict(),
) {}
export class CampaignCatalogPrivacyUpdateDto extends createZodDto(CampaignCatalogPrivacyUpdate) {}
export class CampaignExportRequestDecisionDto extends createZodDto(CampaignExportRequestDecision) {}

// Response DTOs — used as swagger `type:` so the generated spec documents the exact
// projection rather than a free-form object.
export class CampaignCatalogEntryDto extends createZodDto(CampaignCatalogEntry) {}
export class CampaignCatalogPageDto extends createZodDto(CampaignCatalogPage) {}
export class CampaignCatalogBulkResultDto extends createZodDto(CampaignCatalogBulkResult) {}
export class CampaignCatalogPrivacyPolicyDto extends createZodDto(CampaignCatalogPrivacyPolicy) {}
export class CampaignCatalogPrivacySettingDto extends createZodDto(CampaignCatalogPrivacySetting) {}
export class CampaignExportRequestDto extends createZodDto(CampaignExportRequest) {}
export class CampaignExportRequestPageDto extends createZodDto(CampaignExportRequestPage) {}
