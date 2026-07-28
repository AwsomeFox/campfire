import { createZodDto } from 'nestjs-zod';
import {
  CampaignLibraryMonsterCreate,
  CampaignLibraryMonsterUpdate,
  CampaignLibraryTagCreate,
  CampaignLibraryTagUpdate,
  CampaignLibraryCollectionCreate,
  CampaignLibraryCollectionUpdate,
  LibrarySearchQuery,
} from '@campfire/schema';

export class CampaignLibraryMonsterCreateDto extends createZodDto(CampaignLibraryMonsterCreate.strict()) {}
export class CampaignLibraryMonsterUpdateDto extends createZodDto(CampaignLibraryMonsterUpdate.strict()) {}
export class CampaignLibraryTagCreateDto extends createZodDto(CampaignLibraryTagCreate.strict()) {}
export class CampaignLibraryTagUpdateDto extends createZodDto(CampaignLibraryTagUpdate.strict()) {}
export class CampaignLibraryCollectionCreateDto extends createZodDto(CampaignLibraryCollectionCreate.strict()) {}
export class CampaignLibraryCollectionUpdateDto extends createZodDto(CampaignLibraryCollectionUpdate.strict()) {}
export class LibrarySearchQueryDto extends createZodDto(LibrarySearchQuery) {}
