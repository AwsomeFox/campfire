import { createZodDto } from 'nestjs-zod';
import { CatchUpMark } from '@campfire/schema';

export class CatchUpMarkDto extends createZodDto(CatchUpMark) {}
