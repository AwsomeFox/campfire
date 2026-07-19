import { createZodDto } from 'nestjs-zod';
import { UserCreate, UserUpdate, PasswordChange, PreferencesUpdate } from '@campfire/schema';

export class UserCreateDto extends createZodDto(UserCreate) {}
export class UserUpdateDto extends createZodDto(UserUpdate) {}
export class PasswordChangeDto extends createZodDto(PasswordChange) {}
export class PreferencesUpdateDto extends createZodDto(PreferencesUpdate) {}
