import { createZodDto } from 'nestjs-zod';
import { AiDmSeatDefaults, SettingsUpdate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class SettingsUpdateDto extends createZodDto(SettingsUpdate.strict()) {}

// #1070 server-wide AI seat defaults. `.strict()` for the same reason as above.
export class AiSeatDefaultsDto extends createZodDto(AiDmSeatDefaults.strict()) {}
