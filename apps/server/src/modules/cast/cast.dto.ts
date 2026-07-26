import { createZodDto } from 'nestjs-zod';
import { CastSessionCreate, CastSessionExit } from '@campfire/schema';

export class CastSessionCreateDto extends createZodDto(CastSessionCreate.strict()) {}
export class CastSessionExitDto extends createZodDto(CastSessionExit.strict()) {}
