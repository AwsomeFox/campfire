import { createZodDto } from 'nestjs-zod';
import { ScribeConfigUpdate, ScribeRunRequest } from '@campfire/schema';

// .strict() at the DTO layer only — an unknown/misspelled key is a 400, not a silent drop.
export class ScribeConfigUpdateDto extends createZodDto(ScribeConfigUpdate.strict()) {}
export class ScribeRunRequestDto extends createZodDto(ScribeRunRequest.strict()) {}
