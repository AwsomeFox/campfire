import { createZodDto } from 'nestjs-zod';
import { OidcSettingsUpdate, OidcTestRequest } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of being silently stripped
// (see encounters.dto.ts / issue #131).
export class OidcSettingsUpdateDto extends createZodDto(OidcSettingsUpdate.strict()) {}
export class OidcTestRequestDto extends createZodDto(OidcTestRequest.strict()) {}
