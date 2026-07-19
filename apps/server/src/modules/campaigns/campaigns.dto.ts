import { createZodDto } from 'nestjs-zod';
import { CampaignCreate, CampaignUpdate } from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment.
export class CampaignCreateDto extends createZodDto(CampaignCreate.strict()) {}
export class CampaignUpdateDto extends createZodDto(CampaignUpdate.strict()) {}
