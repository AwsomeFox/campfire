import { createZodDto } from 'nestjs-zod';
import { NpcCreate, NpcUpdate } from '@campfire/schema';

export class NpcCreateDto extends createZodDto(NpcCreate) {}
export class NpcUpdateDto extends createZodDto(NpcUpdate) {}
