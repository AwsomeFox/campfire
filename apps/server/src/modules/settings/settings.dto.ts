import { createZodDto } from 'nestjs-zod';
import { SettingsUpdate } from '@campfire/schema';

export class SettingsUpdateDto extends createZodDto(SettingsUpdate) {}
