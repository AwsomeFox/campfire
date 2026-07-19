import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch } from '@campfire/schema';

// .strict() applied here at the DTO layer only — see encounters.dto.ts header
// comment for why the shared @campfire/schema exports themselves stay lenient
// (reused verbatim by mcp-tools.ts / proposals.service.ts). A misnamed write
// field (e.g. an agent sending `hp` instead of `hpCurrent`) now 400s instead of
// silently no-op'ing.
export class CharacterCreateDto extends createZodDto(CharacterCreate.strict()) {}
export class CharacterUpdateDto extends createZodDto(CharacterUpdate.strict()) {}

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
