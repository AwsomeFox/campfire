import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch } from '@campfire/schema';

export class CharacterCreateDto extends createZodDto(CharacterCreate) {}
export class CharacterUpdateDto extends createZodDto(CharacterUpdate) {}

// HpPatch is a z.union(...) — a union can't be a class's instance type when
// using `extends`, so we build the DTO class without extending (nestjs-zod's
// ZodValidationPipe only needs `isZodDto`/`schema` statics on the metatype) and
// declaration-merge in the union as the instance type for @Body() typing.
class HpPatchDtoClass {
  static readonly isZodDto = true as const;
  static readonly schema = HpPatch;
  static create(input: unknown) {
    return HpPatch.parse(input);
  }
}
export type HpPatchDto = z.infer<typeof HpPatch>;
export const HpPatchDto = HpPatchDtoClass;

export class ConditionsPatchDto extends createZodDto(ConditionsPatch) {}
