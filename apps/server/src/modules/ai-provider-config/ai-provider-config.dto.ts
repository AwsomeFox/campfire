import { createZodDto } from 'nestjs-zod';
import { AiProviderConfigUpdate } from '@campfire/schema';

// .strict() at the DTO layer — an unknown/misspelled key is a 400, not a silent
// drop (matches the AI-DM seat DTO). The write payload's `apiKey` is write-only;
// it is never echoed back (reads use AiProviderConfigView, which omits it).
export class AiProviderConfigUpdateDto extends createZodDto(AiProviderConfigUpdate.strict()) {}
