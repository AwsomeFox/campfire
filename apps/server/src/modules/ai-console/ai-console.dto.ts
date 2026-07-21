import { createZodDto } from 'nestjs-zod';
import { AiCapsUpdate, AiKillSwitchUpdate, AiAllowlistUpdate } from '@campfire/schema';

// .strict() on each payload — an unknown/misspelled key is a 400, matching the
// rest of the AI surface (seat + provider-config DTOs).
export class AiCapsUpdateDto extends createZodDto(AiCapsUpdate) {}
export class AiKillSwitchUpdateDto extends createZodDto(AiKillSwitchUpdate) {}
export class AiAllowlistUpdateDto extends createZodDto(AiAllowlistUpdate) {}
