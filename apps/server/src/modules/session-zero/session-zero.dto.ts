import { createZodDto } from 'nestjs-zod';
import { SessionZeroUpdate } from '@campfire/schema';

// .strict() at the DTO layer (see timeline.dto.ts / quests.dto.ts): an unrecognized
// body key 400s instead of the global ZodValidationPipe silently stripping it and
// 200-ing as a partial write.
export class SessionZeroUpdateDto extends createZodDto(SessionZeroUpdate.strict()) {}
