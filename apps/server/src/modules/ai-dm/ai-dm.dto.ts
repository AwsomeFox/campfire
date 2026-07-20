import { createZodDto } from 'nestjs-zod';
import { AiDmSeatUpdate, AiDmTurnRequest } from '@campfire/schema';

// .strict() at the DTO layer only — an unknown/misspelled key is a 400, not a silent drop.
export class AiDmSeatUpdateDto extends createZodDto(AiDmSeatUpdate.strict()) {}
export class AiDmTurnRequestDto extends createZodDto(AiDmTurnRequest.strict()) {}
