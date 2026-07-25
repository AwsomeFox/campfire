import { createZodDto } from 'nestjs-zod';
import { CampaignLibraryMonsterCreate, CampaignLibraryMonsterUpdate } from '@campfire/schema';

export class CampaignLibraryMonsterCreateDto extends createZodDto(CampaignLibraryMonsterCreate.strict()) {}
export class CampaignLibraryMonsterUpdateDto extends createZodDto(CampaignLibraryMonsterUpdate.strict()) {}
