import { createZodDto } from 'nestjs-zod';
import { CampaignDmRepair, UserCreate, UserUpdate, PasswordChange, PreferencesUpdate, AdminTokenCreate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class UserCreateDto extends createZodDto(UserCreate.strict()) {}
export class UserUpdateDto extends createZodDto(UserUpdate.strict()) {}
export class PasswordChangeDto extends createZodDto(PasswordChange.strict()) {}
export class PreferencesUpdateDto extends createZodDto(PreferencesUpdate.strict()) {}
export class AdminTokenCreateDto extends createZodDto(AdminTokenCreate.strict()) {}
export class CampaignDmRepairDto extends createZodDto(CampaignDmRepair.strict()) {}
