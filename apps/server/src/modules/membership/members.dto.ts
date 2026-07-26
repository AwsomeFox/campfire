import { createZodDto } from 'nestjs-zod';
import { GuestDmGrantCreate, MemberCreate, MemberUpdate } from '@campfire/schema';

// .strict() — an unrecognized body key 400s instead of the global ZodValidationPipe
// silently stripping it (see encounters.dto.ts / issue #131).
export class MemberCreateDto extends createZodDto(MemberCreate.strict()) {}
export class MemberUpdateDto extends createZodDto(MemberUpdate.strict()) {}
export class GuestDmGrantCreateDto extends createZodDto(GuestDmGrantCreate.strict()) {}
