import { createZodDto } from 'nestjs-zod';
import { MemberCreate, MemberUpdate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of the global ZodValidationPipe
// silently stripping it (see encounters.dto.ts / issue #131).
export class MemberCreateDto extends createZodDto(MemberCreate.strict()) {}
export class MemberUpdateDto extends createZodDto(MemberUpdate.strict()) {}
