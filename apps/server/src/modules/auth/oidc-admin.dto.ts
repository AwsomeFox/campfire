import { createZodDto } from 'nestjs-zod';
import { OidcSettingsUpdate, OidcTestRequest } from '@campfire/schema';

export class OidcSettingsUpdateDto extends createZodDto(OidcSettingsUpdate) {}
export class OidcTestRequestDto extends createZodDto(OidcTestRequest) {}
