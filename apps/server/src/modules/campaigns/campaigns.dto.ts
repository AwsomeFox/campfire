import { createZodDto } from 'nestjs-zod';
import { CampaignCreate, CampaignUpdate } from '@campfire/schema';

export class CampaignCreateDto extends createZodDto(CampaignCreate) {}
export class CampaignUpdateDto extends createZodDto(CampaignUpdate) {}
