import { createZodDto } from 'nestjs-zod';
import { SettingsUpdate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class SettingsUpdateDto extends createZodDto(SettingsUpdate.strict()) {}
