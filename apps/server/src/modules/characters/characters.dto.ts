import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CharacterCreate, CharacterUpdate, HpPatch, ConditionsPatch, SpellSlotPatch, XpPatch, XpAward, LevelUp, DdbCharacterImport, ExpectedUpdatedAt, CheckRollRequest, CheckRequestCreate } from '@campfire/schema';

// .strict() applied here at the DTO layer only — see encounters.dto.ts header
// comment for why the shared @campfire/schema exports themselves stay lenient
// (reused verbatim by mcp-tools.ts / proposals.service.ts). A misnamed write
// field (e.g. an agent sending `hp` instead of `hpCurrent`) now 400s instead of
// silently no-op'ing.
export class CharacterCreateDto extends createZodDto(CharacterCreate.strict()) {}
// expectedUpdatedAt (issue #746) added here, not in the shared CharacterUpdate — it's a
// request-time CAS concern, not a stored field (see encounters.dto.ts / npcs.dto.ts for
// the same pattern). A character sheet is a blind last-write-wins clobber victim (two
// tabs / a player + DM tab / a connected AI), so it gets the same optimistic-concurrency
// invariant as its quest/npc/location/session/encounter peers.
export class CharacterUpdateDto extends createZodDto(CharacterUpdate.extend({ expectedUpdatedAt: ExpectedUpdatedAt }).strict()) {}

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

export class ConditionsPatchDto extends createZodDto(ConditionsPatch.strict()) {}

export class SpellSlotPatchDto extends createZodDto(SpellSlotPatch.strict()) {}
// XpPatch is a z.union(...) like HpPatch — same no-extends DTO construction as
// HpPatchDtoClass above (see that comment for why).
class XpPatchDtoClass {
  static readonly isZodDto = true as const;
  static readonly schema = XpPatch;
  static create(input: unknown) {
    return XpPatch.parse(input);
  }
}
export type XpPatchDto = z.infer<typeof XpPatch>;
export const XpPatchDto = XpPatchDtoClass;

export class XpAwardDto extends createZodDto(XpAward.strict()) {}
export class LevelUpDto extends createZodDto(LevelUp.strict()) {}
// DdbCharacterImport is already a strict object wrapped in a `.refine` (a ZodEffects),
// so unknown keys are rejected without an extra `.strict()` here (which ZodEffects lacks).
export class DdbCharacterImportDto extends createZodDto(DdbCharacterImport) {}
// Issue #415: roll a catalog check (skill/save/ability/initiative) server-side.
export class CheckRollRequestDto extends createZodDto(CheckRollRequest.strict()) {}
// Issue #415: DM-initiated check request from one or more target characters.
export class CheckRequestCreateDto extends createZodDto(CheckRequestCreate.strict()) {}

export const RestPatch = z.object({
  type: z.enum(['stamina', 'night', 'short', 'long']),
});
export class RestPatchDto extends createZodDto(RestPatch.strict()) {}


