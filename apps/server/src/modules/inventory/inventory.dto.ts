import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';
import { InventoryItemCreate, InventoryItemUpdate, TreasuryPatch } from '@campfire/schema';

// .strict() at the DTO layer only — see encounters.dto.ts header comment.
export class InventoryItemCreateDto extends createZodDto(InventoryItemCreate.strict()) {}
export class InventoryItemUpdateDto extends createZodDto(InventoryItemUpdate.strict()) {}

// TreasuryPatch is a z.union(...) — same workaround as HpPatchDto in
// characters.dto.ts: a union can't be a class's instance type via `extends`,
// so provide the isZodDto/schema statics directly and merge in the union type.
class TreasuryPatchDtoClass {
  static readonly isZodDto = true as const;
  static readonly schema = TreasuryPatch;
  static create(input: unknown) {
    return TreasuryPatch.parse(input);
  }
}
export type TreasuryPatchDto = z.infer<typeof TreasuryPatch>;
export const TreasuryPatchDto = TreasuryPatchDtoClass;
