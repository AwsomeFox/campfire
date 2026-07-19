import { createZodDto } from 'nestjs-zod';
import { MemberCreate, MemberUpdate } from '@campfire/schema';

export class MemberCreateDto extends createZodDto(MemberCreate) {}
export class MemberUpdateDto extends createZodDto(MemberUpdate) {}
