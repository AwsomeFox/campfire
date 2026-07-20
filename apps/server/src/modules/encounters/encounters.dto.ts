import { createZodDto } from 'nestjs-zod';
import { EncounterCreate, EncounterUpdate, CombatantCreate, CombatantUpdate, RollRequest } from '@campfire/schema';

export class EncounterCreateDto extends createZodDto(EncounterCreate.strict()) {}
export class EncounterUpdateDto extends createZodDto(EncounterUpdate.strict()) {}

// .strict() here (not on the shared CombatantCreate/CombatantUpdate exports in
// @campfire/schema — those are reused as-is by mcp-tools.ts and elsewhere, and
// mutating them would ripple well outside this DTO layer): unknown keys in a
// combatant write body 400 instead of silently no-op'ing. This is the concrete
// case that motivated strict-mode: PATCH .../combatants/:cid with a misnamed
// field like `{ hpCurrent: 5 }` (the real column name — CombatantUpdate's actual
// field is `hpSet`/`hpDelta`) previously validated fine (the pipe just stripped
// the unrecognized key) and silently did nothing.
export class CombatantCreateDto extends createZodDto(CombatantCreate.strict()) {}
export class CombatantUpdateDto extends createZodDto(CombatantUpdate.strict()) {}
export class RollRequestDto extends createZodDto(RollRequest.strict()) {}
